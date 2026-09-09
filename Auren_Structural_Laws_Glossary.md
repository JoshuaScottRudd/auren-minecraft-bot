# Structural Laws — Role → Implementation Glossary

> **Purpose.** The Structural Laws describe every part by the JOB IT DOES, never by its name in this
> repository (see the canonical "Architect Notes: What a Law May Contain" — a law naming a symbol is
> wrong the day that symbol moves, and it silently narrows the law to the one place it mentioned).
> Illustration at the level of a job is welcome there; names are not. This file is the one place that maps each
> agnostic role phrase used in the laws to the concrete fragment / file / API that currently
> fills it, so a developer can still ground a law in the codebase.
>
> **This file is NOT injected** with the laws (only `Auren_Structural_Laws_LLM.md` is). Keeping
> the names here keeps the injected law text a pure, agnostic surface.
>
> **This is a WHAT, so it rots (Law 14).** A role phrase in a law cannot go stale — if the role
> disappears the law that names it is edited in the same pass. A name in *this* table can: rename
> or move a fragment and this row silently goes false. **Update this table on any rename/move.**
> The laws are authoritative; where this table disagrees with the code, the code wins and the row
> is stale. Verify before relying on a mapping.

## Roles

| Role phrase in the laws | Current implementation | Law(s) |
|---|---|---|
| the loop's judge / the judge / loop-terminator | `action_fragments.js/recursive_judge.js` | 11, 12, 13, 15 |
| the chain origin | the `Thinking_fragments/` layer — `job_board.js` → `dispatcher.js` | 12, 13 |
| the task source (in the system-level loop) | `Thinking_fragments/job_board.js` | 11 |
| the dispatch step (in the system-level loop) | `Thinking_fragments/dispatcher.js` | 11 |
| the manager (role) | per-domain manager logic (architectural role, not one file) | 11 |
| the executor (role) | `action_fragments.js/*_executor.js` (mining / harvest / build / farm) | 11 |
| recovery fragments / recovery sub-chains | recovery fragments in `action_fragments.js/` — *verify current names; the historical `Destination_assured` / `checkpoint_runner` did not resolve at last check* | 12 |
| looping fragments | fragments that repeat until a condition (e.g. tree-removal, waypoint-running) — verify current names | 4 |

## Diagnostics (Law 5 / 6)

| Role phrase in the laws | Current implementation |
|---|---|
| the diagnostic logging system / the diagnostic log | `js_kernel/watcher.js` (the Watcher) |
| a single per-unit diagnostic file | `watcher_<BotId>.json` |
| the summary level | `summary()` |
| the warning level | `warn()` |
| the error level | `error()` |
| a deferred per-stage context buffer | `buffer` / `record()` |
| an entry/exit duration wrapper | `track()` |
| the shared consolidated state file | `js_kernel/corporate_headquarters.js` → `corporate_headquarters.<BotId>.json` (named offices / conference-rooms / chairs) |

## Accountability and reach (Law 28)

Law 28 says a question — *why did this happen* — must reach a party that both caused the thing and can
change it, and that reach is granted at exactly the scope of the answering. These are the parts that carry
that pairing in the fleet.

| Role phrase in the laws | Current implementation |
|---|---|
| the party answerable for a spawned unit's acts | `js_kernel/bot_mandate.js` — `BOT_MODE` + `BOT_OWNER`; a contractor without an owner is refused at startup, a homesteader with one is refused (it answers to nobody) |
| the stamp naming who answers for a placed thing | the owner written into each station / building row by `perception_nodes.js/station_registry.js` |
| clearing what a unit knows, at one party's own scope | `js_kernel/wipe_system.js` — the `wipe` operator verb; takes **no argument naming whose things**, reads the owner off this process's own mandate, so a foreign row cannot be spelled (Law 27) |
| clearing shared memory at the widest scope | `js_kernel/flush_system.js` — the `flush` operator verb, resetting `corporate_headquarters*.json` whole; correct only from the terminal, where the whole fleet is one person's responsibility |
| the one delivery pathway for either verb | `js_kernel/operator_commands.js` (Law 16) |
| the removal that survives a merge | tombstones written by the wipe, not deletes — every unit re-broadcasts rooms it merely adopted, so an absence is no-news and a deleted place is handed straight back |

## APIs (Law 15 / 16)

| Role phrase in the laws | Current implementation |
|---|---|
| a movement call / movement API | `custom_api/locomotion/navigator.js` — `goTo(...)` |
| a nearby-collection call / a collection capability | `custom_api/drop_collector.js` — `collectNearby(bot)` |
| external libraries (the only legal `catch` boundary) | `mineflayer`, `prismarine`, `pathfinder` |
