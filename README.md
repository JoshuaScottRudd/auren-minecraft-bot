# Auren

A Minecraft bot that decides what to do on its own.

It is not a macro and not a scripted routine. It looks at the world, works out the gap between what is
there and what should be there, picks one job, does it, and looks again. Left alone on a fresh world it
will find a place to live, chop wood, build a house, farm, mine, and defend itself — because it decided
to, not because a list told it to in that order.

You can also hire one. Started as a **contractor**, a bot listens to you in chat and works for you.

---

## AI built it. AI doesn't run it.

**Every line of this was written by an AI.** I never learned to code. I learned to tell it when it was
wrong — which is a different skill, and it is the only one I brought.

**And there is no AI inside it.** The bot makes **zero LLM calls at runtime**. Nothing here phones an
API, wants a key, or costs a fraction of a cent per decision. Everything it does comes from the planners,
judges and perception nodes in this repository, running as plain code on your machine. That is why it
works with no internet beyond the game server, and why you can read back exactly why it did something
instead of asking a model to guess.

Those two facts are the whole project: **AI as the developer, not the pilot.**

---

## What you need

- **Node.js 22 or newer.** `node --version` to check. Older versions will not run this.
- **Minecraft Java Edition 1.21.5.** That is what the bot speaks unless you tell it otherwise, and it is
  the version everything here has actually been run against. Other versions in the 1.21 line will usually
  connect — pass `--version 1.21.4` and see — but block names, recipes and mob behaviour all come from the
  version's own data, so the further you get from 1.21.5 the more likely the bot is to reach for a block
  that is no longer called that. **Bedrock Edition will not work at all**; this speaks the Java protocol.
- **A Minecraft Java Edition server you can connect to.** Your own on your own machine is the easiest
  start. Anything the bot can reach over the network works.
- **Offline mode, or a real account for the bot.** By default the bot logs in without authenticating,
  which a server only accepts when `online-mode=false` in its `server.properties`. On a normal
  online-mode server the bot needs a paid Minecraft account of its own.

---

## Getting a bot into your world

From inside this folder — the one holding `package.json` — two commands, once:

```
npm install
node start_bot.js
```

That is a bot named `AurenBot` joining a server at `localhost:25565`, working its own agenda.

**Brace yourself for the install: it is about 450 MB.** Nearly all of that is one package, `minecraft-data`,
which carries the block, item, recipe and entity tables for every version of Minecraft it supports — the
bot reads them constantly and there is no smaller version of it. Nothing is downloaded at runtime and
nothing is installed outside this folder; delete the folder and it is all gone.

Somebody else's server, and a different name:

```
node start_bot.js --host mc.example.com --name Iris
```

**Stop it with Ctrl-C.** One bot is one process; closing the window ends that bot and nothing else.

`node start_bot.js --help` lists every option. There are seven, and that is all of them.

---

## The two species, and the difference is real

**A homesteader answers to nobody.** It has its own agenda and works it. Say its name in chat and nothing
happens — not because it is ignoring you, but because it has no ear: the chat listener is not mounted at
all. This is the default.

```
node start_bot.js
```

**A contractor works for you.** Same bot, with the human channels added on top. It hears you, takes your
orders, and belongs to whoever you name as its owner.

```
node start_bot.js --mode contractor --owner YourMinecraftName
```

`--owner` is your Minecraft name, and a contractor will refuse to start without one. A homesteader will
refuse to start *with* one. That is deliberate: a bot is born one species or the other and there is no
in-between state where it half-listens to somebody.

Once a contractor is in the world, talk to it in chat. Ask it to build something, ask what it is doing,
tell it to stop.

**What a contractor builds for you is remembered.** It goes in `player_memory/player_hq.<YourName>.json`,
beside the bot, and it outlives the bot: stop the contractor, start a new one under the same owner, and it
picks up your houses and workstations where the last one left off. Nothing sweeps that file — it is there
until you delete it.

---

## More than one bot

Two bots on the same server with no referee will both walk to the same tree. The **overseer** is the
referee: it hands out jobs so that each one has exactly one owner.

Start it once, in its own window:

```
node start_overseer.js
```

Then start each bot pointing at it:

```
node start_bot.js --name Auren --overseer ws://localhost:3001
node start_bot.js --name Iris  --overseer ws://localhost:3001
```

Every bot is still its own process — start and stop them independently. A single bot does not need the
overseer and will say so when it starts alone.

---

## Every option

| option | what it does | default |
|---|---|---|
| `--host` | server address | `localhost` |
| `--port` | server port | `25565` |
| `--name` | the bot's name in the world | `AurenBot` |
| `--mode` | `homesteader` or `contractor` | `homesteader` |
| `--owner` | your Minecraft name — required for a contractor, forbidden for a homesteader | — |
| `--version` | the server's Minecraft version | `1.21.5` |
| `--overseer` | `ws://host:port` of a running overseer | none — the bot plans alone |

Each one has an environment variable behind it, so a flag you type wins and a flag you leave out falls
back to the environment. Anything the bot cannot work out, it refuses to start over rather than guessing.

---

## When something goes wrong — read this part

**Every bot writes down everything it did.** Not a log of what happened to it: a record of what it decided
and why. It lands in:

```
fleet_logs/traces/watcher_<botname>.jsonl
```

The bot tells you this path when it starts. One line per event, plain JSON, in order.

**A bot replaces its own trace file every time it starts**, so the file always holds one run and never a
pile of them. That also means a restart destroys the evidence: if something went wrong, copy the file
somewhere before you start the bot again.

**That file is the whole troubleshooting story, and there is no reader shipped with it.** The tools that
turn a trace into a readable report are built for the author's own workflow and are not designed for other
people to use, so they are not in this package. You have three options and all three are fine:

1. **Read it by hand.** It is JSON text, one event per line, English sentences inside. A bot that got stuck
   usually says so in its own words a few lines before it stopped.
2. **Write your own reader.** It is a JSONL file with a stable shape. Anything that can read lines can
   read it.
3. **Send it to me.** Open an issue, attach the trace, and say what you expected to happen instead. I can
   read these quickly and I would rather fix the bot than talk you through diagnosing it.

Option 3 is the intended path. **If you hit a problem, tell me about it rather than trying to fix it** —
that is not me being precious about the code, it is that a trace tells me in thirty seconds what would
take you an evening.

### Things that go wrong most often

- **The bot connects and is immediately kicked.** The server is in online mode and the bot has no account.
  Set `online-mode=false` in `server.properties`, or give the bot a real account.
- **`Cannot find module 'mineflayer'`.** `npm install` was not run, or was run in the wrong directory. It
  has to be run in the folder holding `package.json`.
- **The bot joins and stands still.** Check the trace. A homesteader on a world with nothing it can reach
  — no wood, spawn-protected ground — will keep re-planning and getting the same answer.
- **Version mismatch on connect.** Pass `--version` matching your server exactly, e.g. `--version 1.21.5`.

---

## What is in this folder

| | |
|---|---|
| `start_bot.js` | the one way a bot is born |
| `start_overseer.js` | the referee, for more than one bot |
| `master_core.js` | what a bot runs once it has been told who it is |
| `Thinking_fragments/` | the deciding — planners, judges, the config you would edit to retune it |
| `action_fragments.js/` | the doing — one file per verb the bot can perform |
| `perception_nodes.js/` | the sensing — what the bot can find out about the world |
| `js_kernel/` | shared machinery: the state store, the trace writer, the calculators |
| `custom_api/` | the layer between the bot's own vocabulary and Minecraft's |
| `overseer/` | job arbitration between several bots |
| `foreman/` | the desk a contractor's owner talks to |
| `fleet_logs/` | where traces land. Each bot replaces its own file when it starts |
| `player_memory/` | one file per person a contractor works for: their buildings and stations, kept until you delete the file |
| `Auren_Structural_Laws.md` | the rules the whole thing is built on. See below |

---

## The Structural Laws

`Auren_Structural_Laws.md` is not documentation of the code. It is the set of design rules the code is
built to obey, written before and alongside it, and the code is full of comments citing them by number.

They are worth reading if you want to understand *why* anything here is shaped the way it is — why a
failure throws instead of returning false, why there is exactly one way to do each thing, why the bot
re-senses the world instead of remembering it. `Auren_Structural_Laws_LLM.md` is the condensed version and
`_Glossary.md` defines the terms.

They are published because they are already stamped through the code in comments; withholding the index to
a philosophy that is quoted on every other page would be a strange kind of privacy.

---

## A note on the comments, and who "the Architect" is

If you open almost any file here you will find long comment blocks explaining not what the code does but
**why it is that way** — what was tried first, why the mechanism made it fail, which Law a branch is
enforcing. Many of them quote decisions, dated, and attribute them to **the Architect**.

**That is me.** I am Joshua Rudd, and I wrote all of this. Auren is built by one person working with AI
coding assistants, and "the Architect" is the role I occupy in that arrangement: I make the design
decisions, the assistant implements them, and the comments are how a decision survives into the next
session — an assistant that arrives with no memory of yesterday reads them and reaches the same conclusion
instead of quietly undoing it. So the third person you are reading is not a team. It is a working
convention between me and a machine, left in place because it is honest about how the code got written.

**You do not need any of it to use the bot.** Read the section above this one and skip the rest. The
comments are there for anyone who wants to know why a Minecraft bot has opinions about error handling.

---

## What this is not

- **Not a plugin or a mod.** Nothing is installed on the server. The bot connects as a player would.
- **Not multiplayer-safe by default.** A bot with no spawn protection configured will dig where it likes.
  It will not touch a 33×33 square around world spawn, and that is the only ground it protects
  automatically.
- **Not finished.** It is a working system under active development by one person. Things change.

---

## Where this is going, and how to be part of it

The bots are being built toward a **multiplayer world** — a server where people live alongside them, and
the bots carry on working whether or not anyone is watching. **That does not exist yet**, and I'm not
going to pretend otherwise. There is no server standing by for you to join today.

**The Discord is the way in, and it is where the work actually happens.** Dev runs get posted there,
failures get pulled apart there, and when the multiplayer door does open, the people already in that room
are the ones who walk through it first.

> ### → **[projectauren.com/discord](https://www.projectauren.com/discord)**

It is also the easiest place to ask me something directly.

---

## Contributing

**Please don't send pull requests.** This is a single-author project with a design system that takes a
while to hold in your head, and a patch written without it costs more to review than to rewrite.

**Do send problems.** An issue with a trace attached is genuinely the most useful thing you can give me,
and it is what this bot is written to produce. If you'd rather just talk it through, the Discord above is
fine too.
