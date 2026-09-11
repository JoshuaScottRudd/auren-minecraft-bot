# `tools/` — what a test is here, and when it is allowed to exist

**Read this before writing, keeping, or running any test in this fleet.** It is short on purpose. The rule
below overrides whatever your training says about test suites, and a cold-start session that skips it will
reintroduce forty files of bloat that were deliberately deleted on 2026-08-10.

---

## The rule

> **A test either shifts with the codebase or it goes. There is no third answer.**
> *(Architect, 2026-08-10 — the second ruling, which superseded the first the same day)*
>
> *"if it needs to be run independently of a live run to assert a claim it made a long time ago then why
> make the claim in the first place? the codebase shifts far too much to make anchors in the code base.
> so unless the test can shift with the code base then it needs to go. verify graph load shifts with the
> codebase and is valuable. none of the others are. they test what the codebase is at the current point
> of time and can become stale and are not useful for every run."*

**What "shifts with the codebase" means, precisely** — it is a property of the instrument, not a
statement about how often it is edited:

> An instrument shifts if it **discovers** what to check. It anchors if it **carries a list**.

`preflight` walks the tree, so a file written tomorrow is covered without anyone remembering to
add it. Every pass is built on that one walk, and nothing in it names a file, a function, an identifier or
a number.

**A token scan passes that test on the walk and fails it on the rule, which is why pass 3 was deleted on
2026-08-15.** For five days this instrument carried nineteen "forbidden token" rules — an identifier that
must appear nowhere in the tree, each with the ruling that had deleted it. The walk shifted; each *rule*
was an anchor on one token. And what the token pinned was a **design decision, not a law**: there is no
law saying the shield must be a timer rather than a toggle, or that there is one combat arm rather than
two. Those are the Architect's calls and he may reverse any of them — at which point the scan reports a
violation against code that is now correct, and an instrument that emits a false verdict is worse than no
instrument (Law 25). The rulings themselves are preserved in
[`architect_scratchpad.md`](../../Documentation/Refurbishing%20planning/architect_scratchpad.md) §15 as a
record of decisions, explicitly not as a checklist.

### What this instrument is FOR, which is the admission test for any future pass

> *"the purpose of verify graph load is to precheck the system under heavy revision and prevent
> regression and drift… a normal LLM will install training data code like catches that are strictly
> banned here… a static problem like the supply issue needs a specific throw for it because we might
> change the whole thing another time. however catches are always banned no matter how the repo shifts."*
> *(Architect, 2026-08-15)*

**The instrument holds only what survives ANY revision of this codebase.** That is a much smaller set than
"things that are true today," and the two are constantly mistaken for each other. The catch rule qualifies
because it does not describe the fleet's design at all — it describes what an AI developer arriving with
conventional training will write on contact, in a repo where it is banned. Redesign every fragment and the
rule is unchanged, because the reflex it guards against is unchanged.

**Everything specific to today's design gets a throw instead, and the difference is where it LIVES.** A
throw sits in the module it protects: rewrite that module and the throw goes with it, so it can never
outlive the thing it was about. A pass in this file has no owner to die with — it survives every refactor
by default, which is exactly the property that turns it into a false verdict. **The test for a proposed
pass: would this still be right after the whole subsystem is rewritten?** For the catch shape, yes. For a
supply job's `need`, no — so it is a throw at `dispatcher._readJobs`, not a scan here.

Every deleted bench failed that test. `station_band_test` §7 scanned three files it named by hand — the
same forbidden call in a fourth was invisible to it, while the file still reported green. That is the
anchor: it pins a claim to the shape the codebase had the day it was written, and every move afterwards
silently narrows what it covers without ever saying so.

**The earlier rule, kept because it is still true and no longer sufficient:**

> **A test is born with the work and dies with it. The permanent residue is a Law 13 throw.**

That one expired a bench when its area cooled. The ruling above is stricter and does not wait: an anchored
bench is already stale the day after it is written, because what it covers has already stopped matching
what exists.

This fleet does **not** keep a standing regression suite. There is no "run the tests" step. There is one
button, one permanent instrument, and a discipline about where a guarantee lives.

**Why**, in the Architect's own words:

> *"we could just put a code 13 throw error. that causes us a single run and one fix instead of idempotent
> tests that add no value over the course of many runs… if restarts are cheap, meaning a bricked fleet can
> be stopped fixed and restarted to continue a run as if it didnt stop, then why do we do all of these
> idempotent tests?"*

**The restart-is-cheap premise is verified, not assumed** — a run with `world: 'continue'` on
`Auren_Workshop/run_config.js` stops, takes a code edit, and resumes on the same world with the
in-progress HQ intact (`fleet_runbook.md` §3). And the exception argues the same way: a *death* is expensive (a corpse's playerdata bricks the login
and needs a full rollback), but **a throw stops the body before it can die.** The throw path is the cheap
path. The un-caught bug is the one that costs a rollback.

**The ledger:** a throw costs one interrupted run and one fix, paid once and only if it ever fires. A test
costs maintenance on every future edit, forever, whether its code is being worked on or not.

---

## The one question that decides whether a test may live

> **Does it discover what to check, or does it carry a list?**

**Discovers → it may live.** `preflight` is the only thing in the fleet that does. **Carries a
list → it dies**, and whatever it was guaranteeing goes to a load-time throw (data), a live run
(behaviour), or the debt table below (nowhere yet). *A list does not stop being a list by moving inside
the one surviving instrument* — that is what pass 3 was, and it is why pass 3 is gone.

Applied honestly, **this expired everything.** Thirteen benches were deleted on 2026-08-10 under it, the
day after twenty-eight were deleted under the weaker rule above. There is one file left. If you are
reading this because you are about to add a fourteenth, the question is not "is this test good" — the
deleted ones were good, some of them were excellent, and two of them had caught real deaths. The question
is whether it will still be checking the right thing after the next refactor moves the code out from under
it. If it names a file, it will not.

---

## The four gates that decide whether a GUARD may be built (Architect 2026-09-10, STANDING)

The question above governs **tests** — things that check the code works. This governs **guards** — things
that refuse. A guard is not a test: it costs nothing to run and everything to carry, because every future
session reads it and every refactor has to keep it passing.

**His words, verbatim:** *"first it must be necessary, you have to find violations in code, second it must
be deterministic because having you check against something that you wrote is illegal. and third it should
cause enough damage to merit its creation."* The fourth is the placement those three imply.

**1. NECESSARY — the violation is COUNTED, in the code or in the history. Never imagined.**
Grep the scope and produce a number before writing a line of the guard. **The count is taken before the
cleanup, not after** — the catch-shape gate shipped on 2026-08-15 at a census of zero, and it was
legitimate because the ~40 it had already driven out were the count that justified it. A defect that was
committed and later fixed is evidence; a defect that *could* happen is not.

**2. DETERMINISTIC — and the specification is the ARCHITECT'S, not the checker's.**
Two prohibitions, both binding. *(a)* The verdict comes from a machine comparison. A check that needs a
model to decide whether something "looks right" has the same defect rate as the work it checks, and the
two correlate — it approves on exactly the turn it would also have written it wrong. *(b)* **The thing the
guard compares against must be ruled by the Architect.** If the AI developer writes the rule, the code and
the check, the check proves only self-consistency and reports green forever. The guard is the developer's
to build; the standard it enforces is not theirs to author. *(c)* Operationally: **it discovers, it never
carries a list** — the same question that governs tests, one scope out. If adding an ordinary new file
requires editing the guard, it will go stale while reporting green.

**3. DAMAGING ENOUGH — the failure must be silent and permanent, not loud or self-announcing.**
A guard that fires on something harmless trains everyone to ignore guards. Reject where the system already
stops and names the cause (a throw *is* the guard), where it degrades but says so somewhere a person
reads, or where the fault clears on the next run.
*Worked rejection, kept as the precedent:* a check for "every `fragment_registry` entry has a `receive`"
passed gates 1 and 2 — `start_injector` was a real three-month violation — and **failed gate 3**, because
the bus already logs `No valid receiver found` and the trace names the target. The entry was deleted and
no machine was built; the reasoning is written into `fragment_registry.js`.

**4. UNAVOIDABLE — it runs without anyone choosing to run it.**
Three legal homes and no fourth: inside **`preflight.js`**, inside a **git hook**, or at **load time in
the code itself** (`fragment_registry`'s assert is the strongest form — the guard is part of the thing).
A check you have to remember to invoke is a regulation wearing a constitution's clothes (Law 27), and the
turn it is forgotten is the turn it was needed.

**Failing any gate, the correct action is to fix the instance and write down why no guard was built.**
That sentence is cheaper than the guard, and it is what stops the question being reopened every quarter.

Evidence, ten scored candidates and the method: `Documentation/guard_admission_10_Sep_26.md`.

---

## The one button

**`node Auren_Workshop/tools/preflight.js`** is the only test in the fleet. Not the only routine one —
**the only one.** Run it after every change. It has four passes, all live:

> **It was called `verify_graph_load.js` until 2026-09-01, which is the name every archive and every
> dated report still uses.** Renamed on the Architect's ask — *"it does more than verify load graph so it
> needs a better name"* — because the old name described pass 1 and nothing else, while the file holds
> four passes and a write briefing. A name that reports a fraction of what the file does is the same
> class of fault the passes exist to catch (Law 7; Law 25 — a label that understates what ran is not a
> smaller truth, it is a different claim). It is called *preflight* because that is where it runs: both
> conductors press it before a JVM starts and before `raised` flips, so a refusal costs nothing. The
> historical documents were deliberately NOT rewritten — they are dated records of what was true when
> they were written, and editing them to match today would make them lie about their own moment.

| pass | catches | status |
|---|---|---|
| **1 — load every file the walk finds** | bad requires, renamed exports, load-time errors, syntax | **live** |
| **2 — every module's load-time throws fire during pass 1** | data integrity: bad key, duplicate entry, inverted band, broken ordering, unresolvable recipe token | **live and free** — a consequence of pass 1, not extra machinery. This is where converted checks land. |
| **3 — unbound identifiers + dead-zone reads** | two ReferenceErrors a loader cannot see, because the line never runs at load time: a name read where **nothing** binds it, and a `let`/`const` read before its own initializer completes — where **too much** binds it | **live** (built 2026-08-14; found a dead cell claim on its first run) |
| **4 — catch shape** | a `try` written anywhere except `external_library_guard.js` | **live** (gate since 2026-08-15, when the census reached zero) |

### The session and record machinery lives at the repo root now — `Sessions/`

**Moved out of this folder 2026-09-01** (Architect: *"lets move all the session logging systems outside of
auren_bot into a different domain… make a new session folder at the root and place all the work that was
previously commited into there and outside of live bot code"*). Seven files went: `session_sync.js`,
`session_board.js`, `session_log.js`, `session_process.js`, `session_pulse.sh`, `record_keeper.js`,
`record_briefing.js`. **Their rules, their commands and the reasoning are in `Sessions/README.md` — read
that, not this file, for anything about committing a turn or archiving a record.**

**Why they are not bot code.** They govern AI-developer sessions and three markdown records that live in
`Documentation/` and `Cognitive_documents/`. None of that is in the `Auren_Bot/` snapshot extract, so a
file in here reaching for it was already governing something the extract does not contain.
The domain boundary now matches what the code actually touches, and the dependency runs one way — the same
shape as `Cutting_room/`, which reads the bot and is never read by it.

**What that leaves `preflight.js` doing.** It stays here, because it is the fleet's one test and it checks
bot code. It loads the session layer **by presence**: if `Sessions/` is on disk it prints the board, the
overlap flag, the disk-churn table and the write briefing; if it is not — which is exactly the extracted
repo — it runs the four passes and prints nothing else. That check is `fs.existsSync`, not a `try`: a
directory either exists or it does not, where a catch around the require would swallow a genuinely broken
module under the same silence (Law 13).

**How the archiver decides what to carry and what to move** — the two markers, the pointer chain, and the
prose it refuses to write — **is in `Sessions/README.md`.** It moved there with the tool.

### The write briefing — the second job, and why it rides the gate

Before any pass, `preflight` prints, **for each of the three records a session writes**: which work it is
for, the current size against that record's own archive trigger, the next archive volume number, the
newest entry already there, the next entry's number where the numbering permits arithmetic, and **the
exact block of text to anchor an `Edit` on** — grown backwards from the last line until it is verified to
occur exactly once in the file.

**Why a briefing rides a test at all.** This is the single point every piece of work passes through, so it
is the only channel that reaches an AI developer *at the moment of work* rather than depending on it
having read a document first. A rule that must be remembered is followed by whoever happened to read it.

**Why it computes rather than describes, which is the whole difference from the reminder it replaced.**
A session that knows it must write a record still has to *locate* the place to write: open the file to
find its end, open it again to find the last round number, list the archive folder for the next volume,
count the lines to see whether the archive is due first. Four lookups per turn, over the largest files in
the repo, paid in context that is then not available for the work. All four answers are mechanical, so
the machine that already opens these files answers them once (Law 26 — the deterministic side does the
deterministic half; the generator does the writing).

**Every figure is discovered, never carried**, which is what lets it live here under the rule at the top
of this file. The only authored numbers are the two archive triggers, which are the records' own ratified
rules. The heading patterns describe a *shape*, not a particular heading — and a record whose shape stops
matching prints a loud "could not find" rather than a confident wrong answer (Law 25: *not found* is
never *nothing to report*).

**Two defects it found on its own first run, both of which it had been printing past:** the scratchpad's
live section carried no number, so a single number-bearing pattern named a section three headings back
and sounded certain about it — fixed by splitting "which heading is newest" from "which number is
highest". And the anchor it handed over was a bare `---`, which occurs dozens of times; an `Edit` on that
fails at best and writes into the middle of the file at worst — fixed by growing the anchor until it is
unique. Both are the same fault the passes below hunt: a well-formed answer that is not true.

*(A fifth pass — declared source scans, the nineteen forbidden tokens — was built 2026-08-10 and deleted
2026-08-15. It was numbered 3 and the two below it were 4 and 5; the numbering closed up. See above for
why it went, and don't rebuild it.)*

All four shift for the same reason: **there is one walk and no file list.** Passes 3 and 4 are built on
pass 1's own `files` array precisely so they can never cover less than pass 1 does. Pass 3 additionally
sweeps the two files pass 1 must exclude for their load side effects — parsing binds no port and opens no
socket, so the exclusion has no reason to apply to it.

**The argument that kept pass 3 alive for five days, and where it fails — worth keeping, because it is
persuasive and a successor will re-derive it.** It ran: *an absence claim cannot go stale. A presence claim
("the arm still raises the shield on a swell") dies honestly with its code, but the ruling behind an
absence is "this must never come back", and no edit can make that untrue except the one it exists to
catch. Absence is also the one thing a `throw` can never assert — `throw` runs when a thing IS there, and
there is no line you can write in one file to state what is not in another.*

Both halves are true. The conclusion does not follow, because it quietly assumes the ruling is permanent.
**These rulings are design decisions, and a design decision is exactly the kind of thing that changes.**
There is no law requiring one combat arm rather than two, or a shield timer rather than a toggle; those
are the Architect's calls, reversible at the table (Law 21). The moment one is reversed the scan reports a
violation against correct code — so the claim that *cannot go stale* can go **wrong**, which is the more
expensive failure. An instrument may only encode what a law makes permanent. The pass that survived this
same question is the catch shape, and it survives precisely because Law 13 is not revisable by a refactor.

**It is also the first step of every run** (Architect 2026-08-10). `Auren_Workshop/run.js` runs it as its
own phase 1 — before the world is touched and before any process is launched, so a refusal costs nothing
— and `lanista_conductor.js` runs it in its preflight, before `raised` flips, so a refusal reaps nothing.
Both stop on a non-zero exit. Nothing else needs to remember it: an ordinary run and a lanista bench each
press the button on their own. It sits there rather than inside the sequence because a load
fault discovered by the LIVE route surfaces ~40 s in, after a rollback, a JVM start and a bot login, and it
surfaces wearing the costume of a bot that will not come online — which is the corpse-login brick's
signature and sends the operator down the wrong repair entirely.

**Pass 2 is the important one to understand.** You do not add a test for a data-integrity claim. You add a
`throw` at the top of the module that owns the data, and `preflight` runs it for free, forever, on
every change. Worked example already in the tree — `js_kernel/utils/combat_utils.js`:

```js
if (!COMBAT_TACTICS[tactic]) throw new Error(`... "${tactic}" is not one of the two built arms`);
if (_TACTIC_OF[n])           throw new Error(`... "${n}" is under both ${_TACTIC_OF[n]} and ${tactic}`);
```

---

## Where a guarantee is allowed to live

| the claim | its home |
|---|---|
| Data is malformed (bad key, duplicate, missing field, inverted range) | **A load-time throw** in the module that owns the data. |
| A rule between constants (X must outrank Y; the ramp must not reverse) | **A load-time throw**, because the invariant is derivable from the data alone. |
| Code that must **not** exist (no second combat arm, no swing refusal) | **Nowhere — and that is the answer, not a gap.** A design ruling is not a law and may be reversed; an instrument encoding one emits a false verdict the day it is. Its home is the header of the file it was deleted from (Law 14: name the wrong turn). |
| One construction must be the only pathway (a supply job carries `need`) | **A Law 13 throw at the boundary that CONSUMES it.** Worked example: `dispatcher._readJobs`. |
| An identifier is read where nothing binds it | **`preflight` pass 3.** Neither a throw nor a load can reach it — see below. |
| Behaviour needing a world (does the shove hold, does the bot reach the mob) | **A live run** — `tools/lanista.js` makes combat on demand. |
| How a browser SURFACE actually renders (does it draw at all, does the text fit, did the page throw) | **A photograph** — `Cutting_room/photograph_page.js`. See below: nothing short of a renderer can answer it. |
| Anything else | **Probably nothing.** Ask the question above before writing a file. |

### The surface that no pass can see — `photograph_page.js` (now in `Cutting_room/`)

**It moved out with the editor.** The surfaces it photographs are the cutting room's pages, so it lives
beside them at `Cutting_room/photograph_page.js` — nothing in `Auren_Bot/` has a browser surface to look
at. The reasoning below is why it exists at all, and it is kept here because it is an argument about
INSTRUMENTS rather than about the editor: a pass that reads source cannot see a rendered page, whatever
the page belongs to.

Passes 1–4 all read source. A page whose every import resolves, whose every element exists and whose every
route answers can still render **nothing** — one stylesheet rule that sizes a box as if it had no contents
collapses the picture to zero pixels, and there is no symbol anywhere for a pass to catch. That happened,
and four green instruments plus a live server exercising the routes underneath reported healthy the whole
time.

This is Law 26's truth guarantee read backwards. A machine cannot emit a falsehood *while it runs*; remove
the run and only the form checks survive. Reading markup instead of rendering it removes the run. **The
screenshot is the run**, which is why the browser is not a convenience here but the only thing standing
behind any claim about how a surface looks.

It **shifts with the codebase** and so is allowed to exist (the rule at the top of this file): it carries
no list of pages, no expected pixels and no assertions. It is handed a URL and reports what a real browser
did with it — the picture, anything the page threw or logged, and the answer to any question asked of the
live DOM with `--read`. Nothing in it names a file, so no refactor can leave it green while checking
nothing. It asserts nothing and therefore cannot go stale; it *shows*, and the reader decides.

```
node Cutting_room/photograph_page.js /config
node Cutting_room/photograph_page.js "/thumbnail?take=<take>&profile=highlight" --until="document.querySelector('.tb')" --read="document.querySelector('.tb').textContent"
node Cutting_room/photograph_page.js "/highlight?take=<take>" --do="document.querySelector('#reelIn .clip').click()" --do="document.getElementById('textHere').click()"
```

Pictures land in `footage/_shots/`, which is out of Git. Two mistakes it refuses rather than photographs,
both of which otherwise produce a flawless PNG of the wrong thing: a path the shell rewrote into a Windows
file path, and a port with nothing listening on it.

### Pass 4 — a Law 13 rule, enforced as a SHAPE

**Read this as Law 13 first and Law 16 second.** The one-pathway reading — *the fleet already owns one
boundary translator, so a second is a redundant route* — is true and it is the smaller half; taken alone
it prices the rule as tidiness. The load-bearing half is **default-stopped**: a catch is a decision to
CONTINUE, written before anyone knows what will arrive at it. Law 13 inverts that burden — code proves it
is safe to proceed rather than proceeding until it cannot — and a hand-written catch proves nothing. It
converts an unknown into a known-good path by assertion, at a place chosen for where the author expected
trouble rather than for where the trouble is.

**Why that costs more here than in a smaller system.** A defect that throws surfaces at its own line, with
its stack, and travels to `master_core`'s `uncaughtException` handler. The same defect behind a catch
surfaces as a warn line and a not-done outcome — *the system deciding not to act, repeatedly, with an
explanation* — which is indistinguishable from a gated or blocked world condition. Across a graph this
size that is a bug with somewhere to hide: it reads as a plan problem and the search starts in the wrong
subsystem. The census's own findings are the demonstration: a catch that answered **"you can see it"** on
a line-of-sight predicate, one that closed a build as **FINISHED** because the instrument measuring it
broke, one that returned an **empty cell list** that read as a completed field, and one that ended a
signal chain with a bare `return` while the fleet waited on a signal that would never come.

Law 16 supplies the one exception and the shape it must take: a translator turning a third-party throw
into an outcome, which logs and never swallows. **That rule cannot be enforced by reading catches.** A
catch doing the wrong thing is textually identical to one doing the right thing — the difference is what
it wraps and what it does next, which is a judgment, and a scan that guesses at judgment emits false
verdicts and gets worked around.

**A marker comment was the obvious alternative and it does not work.** `// LAW16-BOUNDARY` is a
*declaration*: anything can type it without having done what it claims, so scanning for it proves a
string is present, never that a boundary is correct. That is Law 26's simulation case — the form survives
and the guarantee behind it is deleted.

**So the rule moved off the catch and onto a shape.** One module — `js_kernel/utils/external_library_guard.js` —
owns the only `try` in the fleet and exports `guardExternal` / `guardExternalSync`. The checkable question becomes
*"is there a `try` outside that file"*, which an AST answers with no judgment at all, and which **cannot be
faked**: either the call goes through the helper or it does not.

The shape also makes three guarantees hold **by construction** instead of by 260 hand-written copies:
a coding violation is always rethrown (one implementation cannot disagree with itself, and cannot be
swallowed by an enclosing hand-written catch the way a per-file rethrow can); nothing is silent, because
there is no empty body to write; and the failure arrives as a value the caller branches on, so a catch is
never the expected pathway.

**A site has three possible repairs, and only one of them is a wrapper.** A third-party call becomes a
`guardExternal` — *and its `{ok, value, reason}` must be read*, which is where five sites turned out to be
throwing the answer away. A guard around *our own* code is **deleted** so the throw travels; wrapping our
own code converts a defect into a quiet decline-to-act, the most expensive failure shape here. A `try`
whose only clause is `finally` was never a guard at all — it becomes `withCleanup` / `withCleanupSync`,
which release on every exit and **catch nothing**, so a throw passes straight through.

**The recurring defect the migration found, in one sentence: _a default is not a measurement._** The
shape repeats across every subsystem — a measurement throws, the catch leaves the variable at its declared
default (`0`, `null`, `false`, `{granted:false}`, `'error'`, `999`), and nothing downstream can tell that
default from a reading. The fleet then acts, correctly and confidently, on a measurement nobody took
(Law 25). That is the class of bug the gate exists to keep out, not the `try` keyword.

**The watcher is the second exempt file, and its exemption is checked rather than granted.** `watcher.js`
cannot route its own failures through the guard, because the guard reports BY CALLING THE WATCHER: on the
exact failure it exists to translate — a log write that will not complete — the report re-enters the broken
writer and recurses. That is structural; no ordering of requires removes it. So the watcher carries its own
translator, `_selfFault`, which reports to `console.error`, the one channel that does not depend on the
channel that just failed. The exemption is therefore not *logging is special* but ***the log's own boundary
must report somewhere the log is not*** — and inside that file a catch must do one of three AST-visible
things: call `_selfFault`, rethrow (instrumentation that observes a failure and lets it travel), or sit
inside `_selfFault` itself, which is the one terminal swallow in the fleet (if `console.error` throws on a
closed stderr there is no remaining channel to report a failure to report). A fourth shape **fails the
pass**, immediately and hard.

**The overseer link carries the same structural bend, and is left UNGUARDED rather than exempted.**
`overseer_link.forwardLog` sends the watcher's own lines up the socket; the guard reports by calling the
watcher, and this function is called *by* the watcher, so guarding it recurses on exactly the failure it
would report. It is precluded instead of caught: an `isConnected()` precondition proves `readyState ===
OPEN`, which is the only thing `ws.send` refuses on (Law 26 — the interface must not report through the
channel it is reporting about).

**`--catch-detail` classifies every site.** Two
mechanical axes decide each outcome, and neither needs judgment: *what the try body touches* — `library`
(it calls a method rooted at a foreign binding, or requires a foreign module), `read` (it only reads a
property off one, where a null from an unloaded chunk is a genuine world condition), or `own` (neither) —
and *what its catch does*: `empty`, `silent` (acts, never logs), `logged`, `rethrow`, `finally-only`. The
pair maps straight onto the three repairs above, and it prints on a **failure** now rather than behind the
flag — the reader at a failure just wrote one `try` and needs to know which repair it takes, not a survey.
The flag still lists every site for a sweep. Note the discriminator is a foreign **call**: passing
`bot` into one of our own functions is our code throwing, and `require('@alias/x').y()` inside a try is
ours too — counting either as a boundary would license a wrapper around exactly the defect class this
migration exists to stop hiding.

**Its scope is the FRAGMENT GRAPH and nothing else, which is a limit rather than an oversight.** Pass 4
sweeps the same files the walk found — `Auren_Bot/monitoring/` and `Auren_Workshop/tools/` are not fragments
and are not in it. Those directories still hold hand-written catches the census has never counted, and
the printed number must always be read as "in the fragment graph", never as "in the repository". Widening
the walk would put the instruments under a rule written for the construct; the two are separate categories
and the boundary is deliberate (Law 26).

**It is a gate now, and the printed-figure phase is worth keeping in the record because it is the general
procedure for landing an unsatisfiable rule.** The fleet held ~270 hand-written try blocks predating the
module. A gate on day one would have failed every run, which enforces nothing and removes the one button
everything else presses — so the pass printed a census instead, under one condition: *the number may only
ever go down.* A number under watch is visible drift; a rule nobody can satisfy is ignored drift. The
census reached **zero on 2026-08-15** and the pass became the gate the figure existed to earn. One
hand-written `try` now exits non-zero, which stops the conducted run in preflight — before a JVM starts,
which is the only place a default-stopped rule is cheap to honour.

### Why the unbound identifier needed its own pass rather than a throw

Every other code-level guarantee here resolves to a load-time throw, and this one cannot. **Loading a
module executes only its top level** — requires, constants, `module.exports`. A name referenced inside a
function body is not evaluated until that function runs, so a reference to a binding that does not exist
in its scope survives pass 1 completely: the file imports clean and wires clean. There is no line anyone
can add to a module that asserts a name is bound somewhere further down inside it.

**The two ways it gets written are both ordinary edits**, which is why it recurs: a refactor deletes the
statement defining a local while a use of it survives lower in the file, and a function extracted out of
its parent keeps reading a binding that stayed behind in the parent's scope. Neither touches the top
level, so neither is visible to a loader.

**It is worth an instrument because the failure is quiet rather than loud.** A `ReferenceError` thrown
deep in a manager lands in the nearest catch, and the catches in this fleet are written for a world that
misbehaves — warn, skip the item, return a not-done outcome. So the fault presents as the system
*declining to act*, repeatedly, with an explanation, which reads as a gated or blocked condition instead
of a crash. Both known instances presented that way: one made every farm plot skip while the run looked
healthy, the other made every mining cell claim report as errored so no cell dispatched at all.

**It qualifies under the rule at the top of this file because it shifts.** It runs on the same walk as
passes 1 and 3 and names no file, function, or identifier — it discovers the whole set every time, so a
file written tomorrow is covered the day it exists. Its allowlist has the same property by construction:
the permitted globals are read off `globalThis` at run time rather than typed out, because a hand-written
global list is an anchor in the one place that would silently un-cover things as Node changes.

**The same pass answers a second question, because the analyzer has already answered it.** `const x = x()`
binds `x` perfectly well — to the very variable being declared — so the unbound half is correctly silent,
while the line throws `Cannot access 'x' before initialization` the moment it runs. Same symptom, opposite
cause: too many bindings rather than none. It belongs in this pass because it is the same parse and the
same walk; splitting it out would read every file twice to ask something already in hand.

**It is a decomposition's signature failure**, which is why it is worth an instrument rather than left to
review. A file-private helper `_x` and some caller's local `x` coexist safely while they sit in different
scopes. Extracting the helper into its own module makes it an export, the leading underscore stops being
true, and dropping it collapses two names into one — the local now shadows the import, and the initializer
that meant to call the helper calls itself. Nothing about the top level changes, so pass 1 is silent too.

**One distinction is what makes it usable, and a version without it is worse than nothing.** A reference
inside an initializer is only in the dead zone if it is *reached during* that initializer. `const walk =
(d) => { ... walk(sub) ... }` puts the reference inside a nested function body, which runs after the
binding is initialized and is correct — ordinary recursion, and there is a lot of it. The discriminator is
a function boundary between the reference and the declaration, not text position, which is again why this
needs the analyzer and not a search. The rule was measured over the whole tree before it shipped: with the
boundary test, zero reports; without it, fifteen, every one of them legitimate recursion. A pass that
cries wolf gets worked around instead of fixed.

**It uses a real parser, and that is not optional.** Deciding whether an identifier is bound requires
scope, and scope requires an AST — hoisting, block-vs-function scope, shadowing, parameters, catch
bindings and closures all change the answer for identical text. A regex approximation emits false
verdicts in both directions, and a scanner whose verdict cannot be trusted gets worked around rather than
fixed (Law 25/26). `espree` + `eslint-scope` — the analyzer behind the standard `no-undef` — are
**vendored into `tools/vendor/`, deliberately in the tracked tree**: `node_env2/` is gitignored, so a
parser installed there would exist on one workstation and be missing on the other. `.gitignore` carries
one negation for this path, in the descend-then-negate form its own header documents.

**Vendor the published tarball, never the repository source — this is the failure that cost the pass for
eleven days (2026-08-15 to 2026-08-26).** `espree`, `eslint-scope` and `eslint-visitor-keys` are all
`"type": "module"` and ship their CommonJS entries as BUILD ARTEFACTS: `dist/*.cjs`, produced by rollup
at publish time and absent from the source tree. A vendoring that copied source only left `main` pointing
at a file that had never existed, and `acorn` arrived with no code at all — a `bin/` and a README. To
re-vendor: `npm install` with `Auren_Workshop/tools/vendor` as the prefix, then confirm `dist/` exists under
`espree`, `acorn`, `eslint-visitor-keys` and `eslint-scope` before committing.

**What the pass is worth, stated as a fact rather than a hope.** It was deleted on 2026-08-26 and restored
the same day, because in between a thirteen-file extraction shipped `BUILDING_REQUIREMENTS is not defined`
into a live run. Two things about that are structural rather than incidental. The extraction of a function
away from the scope holding a binding it reads is one of exactly two ways this fault gets written, and it
is what any decomposition does by definition — so the risk scales with the refactor, which is when an
instrument is least likely to be watched closely. And the substitute tried in its place was a regex over
the source, which reported clean: its lookbehind skipped identifiers preceded by `.` to avoid property
accesses, and so skipped a spread's three dots. That is the false verdict this file's own argument
predicts, produced on the first attempt, on the one identifier that mattered.

**A missing parser fails the run; it never skips the pass.** The tempting shape is to check when the
parser resolves and pass silently when it does not, which turns the one instrument that runs on every
change into something reporting OK while checking nothing — on whichever machine is missing the install.
"Not run" is never "passed" (Law 25).

---

## The three test categories — kept as the *reasoning*, no longer as a lifecycle

The 2026-08-10 ruling collapsed these: only the first category can discover what to check, so only the
first survives, and its sole member is `preflight`. The table is kept because it still explains
*where a claim goes* once the bench holding it is gone.

| category | what it asserts | where its claims go now |
|---|---|---|
| **Structural Validator** | A fact about the *codebase*. | **This is the surviving category.** Pass 1 + 2 + 3. |
| **Policy Validator** | A decision table is coherent — ordering, thresholds, ramps, registry shape. | **A load-time throw.** These never needed to be a file. |
| **Scenario Test** | Behaviour given an authored world value. | **A live run**, or nothing. Never a file. |

**The line between Policy and Scenario is who owns the number the test types in.**
A value the *rule* owns ("far from a chest", "stone tier") cannot rot — there is nothing to measure it
against. A value *reality* owns (a zombie's speed, a measured shove) rots silently, because reality keeps
moving and the typed number does not.

**One refinement that decides the hard cases:** a test may legally transcribe a real-world number **when
that number is the subject** — if a skeleton's eye height changes, the test *should* fail. The disease is
transcribing a real number and using it as a **yardstick to judge something else**. *Subject fine, yardstick
rots.* That is what killed the knockback-cycle assertions: the shove beside it was measured and moved; the
zombie speed judging it was typed and did not.

---

## THE DEBT — claims deleted on 2026-08-10 that are owed a throw

**28 test files were deleted.** Fourteen carried an integrity claim that has **no home yet**. Until the throw
is written, that guarantee does not exist. This table is the only record of what was owed — do not delete it
until the "owed" column is empty.

| deleted test | the claim it carried | owed where |
|---|---|---|
| `monster_tactics_test` | every monster in the doc has a tactic; no doc-group spans both arms; keys lowercase; closed vocabulary | `js_kernel/monster_tactics_registry.js` load |
| `dispatch_priority_test` | seeds outrank the base build; logs rank below it | `Thinking_fragments/architect_config.js` priority table |
| `tool_tier_test` | the sword/axe rows are min 2 / target 2 | `architect_config.js` STOCK_THRESHOLDS |
| `hunger_system_test` | must-eat < eat-at < full | `architect_config.js` hunger constants |
| `death_pile_economics_test` | the dump ramp's endpoints are ordered and it never reverses | the dump-threshold function's module |
| `crafting_registry_test` | every recipe token resolves to a real item or group | `js_kernel/crafting_blueprint_registry.js` load |
| `blueprint_registry_test` | the blueprint file parses and its rows are well-formed | `js_kernel/blueprint_registry.js` load |
| `terrain_predicates_test` | every eye height is positive and below its own body height | `js_kernel/utils/movement/terrain_predicates.js` |
| `voxel_reader_test` | the fast and slow read paths agree | sample a handful of known state ids at load in `js_kernel/utils/voxel_reader.js` |
| `world_forge_test` | no mountain/ocean in the accept list; the elevation band is not inverted; the floor is above sea level; the protected list is non-empty | `tools/world_forge.js` load |
| `idle_loop_test` | the idle window is 10 s | the limiter's module |
| `recursive_judge_test` | the kill threshold is 5 | `action_fragments.js/recursive_judge.js` |
| `farm_seed_budget_test` | the till budget can never go negative | the farm budget function |

**The other 14 deletions are owed nothing.** Their honest answer is: *if it breaks, one run tells us, and
the restart is cheap.* For the record they were — `wheat_scan_test`, `supply_manager_test`,
`torch_integrity_test`, `compost_chain_test`, `lock_all_buildspots_gate_test`, `pillar_sweep_test`,
`signal_sequencer_test`, `sentry_round_trip_test`, `combat_engagement_test`, `rcon_link_test`,
`test_conductor_test`, `lanista_conductor_test`, `locomotion_course_test`, `light_probe_test`.

*(The last five were **bench-on-bench** — they tested the testing tools, not the bot. `light_probe_test` was
a scenario test with zero assertions and its own header calling it "one-shot".)*

---

## THE SECOND DEBT — the 13 deleted the same day, under the stricter rule

**All thirteen survivors were deleted on 2026-08-10**, hours after the table above was written. The
ordering rule that protected two of them was satisfied first, not waived: pass 3 was built before the
deletion and the absence claims moved into it. **Pass 3 itself was then deleted on 2026-08-15, so those
two claims now have no enforcement at all** — recorded plainly below rather than left reading as covered.

**Claims that MOVED to pass 3 and are now UNENFORCED (2026-08-15):**

| deleted bench | the claim | status |
|---|---|---|
| `station_band_test` §7 | no retreat planner, no deleted creeper calculator, no second arm, no species check routing into one, no per-fuse hit cap, no phase machine | **nothing enforces it.** Each is a design ruling, not a law, and that is precisely why pass 3 could not hold it — the ruling is reversible and the scan was not. Its home is the header of the file each thing was deleted from (Law 14). |
| `swing_never_withheld_test` | no swing withheld by a calculation | **nothing enforces it** — and of the two this is the one worth watching, because it is the closest of the nineteen to a standing rule rather than a design choice. `combat_utils`' own header names `bot.attack` on a combat path as the regression to watch. |

**Claims that DIED WITH THEIR BENCH, owed nothing.** These were pinned to numbers or shapes the code owns
and can legitimately change; a changed number is a code change, and a guarantee about it is void by design:

`combat_primitives_test` (weapon table, charge curve, invulnerability floor, falling-edge crit tick),
`combat_calculators_test` (escape geometry, jump apex, threat scanner), `station_band_test` §§1–6 (the
band constants, the RUSH/HOLD decision table), `lanista_test` · `lanista_ladder_test` · `arena_sites_test`
(CLI dials, wave-spec parsing, siting geometry, the deterministic spiral), `combat_checkpoint_test`
(the shared checkpoint clock), `fuse_meter_test` · `knockback_meter_test` · `blast_recorder_test`
(instrument behaviour for measurements now taken).

**⚠️ ONE CLAIM LOST ITS ONLY ENFORCEMENT AND NOTHING CAN CHEAPLY REPLACE IT:**

| lost with | the claim | why nothing holds it |
|---|---|---|
| `combat_lens_battle_test` | `battle_stations.bucketRetirement` and `combat_lens.KILL_VERDICT` must agree on which verdict earned a kill | The two run in different processes and cannot share code (the gate needs the `@kernel` graph; `monitoring/` must run with no Minecraft installed). A throw cannot see across the boundary, and no surviving pass can say two strings in two files must match. |

If they drift, every wave report is quietly wrong in the direction of the change. Both call sites now say
so in their own headers, and `monitoring/README.md` carries the same warning: **edit one, edit the other in
the same commit.**

**Also cleaned up in the same pass:** `battle_stations.js` stopped exporting `enqueue, admitAggro,
orderQueue, pickTarget, mayRepick, refreshTarget, retirementVerdict` — that surface existed for the deleted
bench and had no production caller. An export kept alive for a caller that no longer exists is a doorway
nobody is watching.

---

## What survives — one file

| file | why |
|---|---|
| **`preflight.js`** | It discovers what to check instead of carrying a list, so it cannot go stale. Three passes, run at the head of every conducted run. |

There is no other test in this fleet, and the next one has to earn the same property.
