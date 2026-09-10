# MECHANISM REGISTRY — every named mechanism in the bot, one line each

**Date opened:** 2026-09-10
**Mutability:** Living — a new mechanism means a new line here, in the same commit that creates it.

---

## What this is, and why it is not `fragment_registry.js`

**They answer different questions and only one of them is for a reader.**

| | `js_kernel/fragment_registry.js` | this file |
|---|---|---|
| **who reads it** | the signal bus, at runtime | a person, or an AI developer starting cold |
| **what it holds** | 31 names that a signal can be **routed to** | every named mechanism in the bot, routable or not |
| **what it is for** | resolving `payload.task` → a module with a `receive` | knowing a mechanism **exists** before you build a second one |
| **what it omits** | everything with no `receive` — which is most of the bot | nothing |

`snapshot_registry`, `voxel_scan_throttle`, `durable_write`, `dig_authority`, `inventory_lens` and
`spawn_protection` are all load-bearing, all cited by many callers, and **none of them can ever appear in
`fragment_registry.js`** — they are not signal targets. Before this file, a cold-start session could only
find them by already knowing their names.

**That is the whole reason this exists.** It is the same argument
`Cognitive_documents/0_CANONICAL/SYSTEM_REGISTRY_Named_Mechanisms.md` makes for the corpus: **grep only
finds a concept you already know exists.** A named mechanism nobody remembers is unreachable by search, so
the repository's compositional value — build the next thing out of the named parts, rather than inventing
a fourth way to do something (Law 22 gate 2, Law 16) — is bounded by recall instead of by the record.
This file removes that bound. It is an index of names, **not** a restatement of what they do.

### Invariants

- **One line per mechanism: name — the one thing it is the only way of doing.** If an entry needs a
  paragraph, the entry is wrong; the paragraph belongs in the file's own header comment.
- **Never restate a file's contents here.** The header comment is the documentation; this is the index.
- **A new mechanism is added here in the same commit that creates it.** An unregistered mechanism is an
  unreachable one, and the next session will build a second copy of it.
- **Deleting a mechanism deletes its line.** A registry that lists what is gone is worse than none.

> **This index is not machine-checked.** `preflight.js` proves every file loads and every name resolves;
> nothing proves this file is complete. That is a known gap and it is the honest state — see the
> suggestion at the bottom.

---

## A. The decision loop — Sense-Plan-Act (Law 11)

- **signal_bus** — routing. A signal is delivered only when `payload.task === target`, and this is the one place any signal passes. `js_kernel/signal_bus.js`
- **fragment_registry** — the runtime manifest: symbolic task name → module with a `receive`. Asserts at load that every dispatcher target has an entry. `js_kernel/fragment_registry.js`
- **signal_sequencer** — detects two live signals in one bot's planning loop and names where the second was born. Owns the dead-stop latch the bus reads. `js_kernel/signal_sequencer.js`
- **recursive_judge** — the loop's return point: where a finished or abandoned job re-enters planning. `action_fragments.js/recursive_judge.js`
- **job_board** — one-pass world evaluation producing a ranked job list. `Thinking_fragments/job_board.js`
- **assessor_registry** — which assessments exist and in which two orders the sweep uses them. `Thinking_fragments/assessor_registry.js` + `assessors/` (15)
- **job_gates** — every reason a fully-built job may be disqualified before it is posted. `Thinking_fragments/job_gates.js`
- **job_ranking** — where a posted job's position comes from: two names, never a number. `Thinking_fragments/job_ranking.js`
- **dispatcher** — picks the lowest unmet need *this species may take*. `Thinking_fragments/dispatcher.js`
- **requested_work** — which requirements are live for this body; the whole contractor/homesteader split. `Thinking_fragments/requested_work.js`
- **idle_scheduler** — the re-entry heartbeat when every job is peer-claimed and the chain would otherwise terminate for good. `js_kernel/idle_scheduler.js`
- **portable_judge** — stall and oscillation detection inside a running executor. `js_kernel/portable_judge.js`
- **architect_config** — every tunable that shapes fleet behaviour, as pure data. Nothing downstream redefines a table. `Thinking_fragments/architect_config.js`

## B. Perception — re-sense, never remember

- **spawn_protection** — the one answer to "may this cell be changed", sensed from the server rather than assumed. `perception_nodes.js/spawn_protection.js`
- **threat_scanner** — what is hostile and where. `perception_nodes.js/threat_scanner.js`
- **the integrity family** — "is what I built still there and still right": `building_integrity`, `farming_integrity`, `mining_integrity`, `health_integrity`, `torch_integrity`
- **the siting family** — "where should the next thing go": `farmland_site`, `blueprint_survey`, `mining_blueprinter`, `mining_cell_graph`, `station_registry`, `surface_filter`
- **the resource family** — "where is the material": `biome_scanner`, `ground_drop_scanner`, `stone_column_scanner`
- **voxel_reader** — the one bulk block-read pathway. `js_kernel/utils/voxel_reader.js`
- **voxel_scan_throttle** — the one cooperative pacer for any scan reading hundreds of voxels. Reused, never re-invented. `js_kernel/utils/voxel_scan_throttle.js`

## C. Action — a manager decides, an executor does

- **building** — `build_executor`, `building_manager`, `blueprint_paster`, `preconstruction`, `land_prep`, `find_buildingspot`, `set_buildspot`, `lock_all_buildspots`
- **mining** — `mining_executor`, `mining_manager`, `stone_prospect_executor`
- **farming** — `farm_executor`, `farm_manager`, `harvest_executor`, `compost_executor`
- **supply and crafting** — `supply_manager`, `delivery_executor`, `ground_salvage_executor`, `craft_executor`, `furnace_executor`
- **survival** — `eat_executor`, `eat_manager`, `death_manager`, `torch_executor`, `await_aggro`
- **exploration** — `exploration_executor`, `canopy_clear_executor`
- **idle and reporting** — `idle_park`, `report_to_owner`, `set_wood_preference`

## D. The body — the layer between the bot's vocabulary and Minecraft's

- **locomotion** — getting from here to there, with a judge that can veto the route. `custom_api/locomotion/` (dispatcher, judge, navigator, survival_instincts)
- **motion primitives** — the raw movement verbs everything above stands on. `js_kernel/utils/movement/` (drive, motion_primitives, terrain_predicates, scaffold_movement, combat_movement, movement_config)
- **dig_authority** — the one dig route. Every dig in this system lands here. `js_kernel/utils/movement/dig_authority.js`
- **place_authority** — the one place route. Every block this fleet lays lands here. Together with `dig_authority` these two functions are **the complete set of ways this construct changes the world**. `js_kernel/utils/movement/place_authority.js`
- **the tank crew** — combat as three seats with one writer per board section: `commander` (the fleet's only monster scanner), `gunner` (facing and swinging), `driver` (the lower body), `crew_board` (where they agree about the world). `custom_api/`
- **battle_stations** — the emergency hook every executor and the navigator move loop `await` at loop boundaries. `custom_api/battle_stations.js`
- **fuse_meter** — the creeper fuse counter. `custom_api/combat_counters/fuse_meter.js`
- **the sub-loop APIs (Law 15)** — a caller says "I want this and it isn't here" and may be abandoned mid-loop: `tree_feller`, `seed_picker`, `drop_collector`, `anchored_repair`, `inventory_swapper`, `craft_handler`, `exploration_api`
- **anchored_repair** — the one stationary anchor-build routine, shared by `build_executor` and `mining_executor`. `custom_api/anchored_repair.js`
- **chest_lock_utils** — the one wait-for-release primitive for peer-locked chests. A locked chest stays fully readable; only the write waits. `js_kernel/utils/chest_lock_utils.js`
- **the calculators** — pure arithmetic with no world access: archer, attack cadence, build material, food, inventory, jump, smelt, stack split. `js_kernel/utils/calculators/`

## E. State and memory

- **corporate_headquarters** — memory-primary shared state (Law 6). All reads and writes through one cache with a periodic flush. **The only dynamic state a bot carries.** `js_kernel/corporate_headquarters.js`
- **snapshot_registry** — the mechanism behind *every* declared data file: snapshotted once at boot, used from that snapshot for the whole run, never re-opened. One implementation, not one per file. `js_kernel/snapshot_registry.js`
- **blueprint_registry** — the one route to `building_blueprints.json`. `js_kernel/blueprint_registry.js`
- **crafting_blueprint_registry** — the one route to `crafting_blueprints.json`. `js_kernel/crafting_blueprint_registry.js`
- **monster_tactics_registry** — the one route to `monster_tactics.json`. `js_kernel/monster_tactics_registry.js`
- **inventory_lens** — the one place anything asks where a material is and how much of it exists. Nothing assembles a material pool of its own and nothing counts a chest itself. `js_kernel/inventory_lens.js`
- **request_ledger** — what a human has asked this crew for, and how far it is from done. A request is a stock row, not a job. `js_kernel/request_ledger.js`
- **requestable_catalogue** — what a human *may* ask the fleet for, computed rather than listed. `js_kernel/requestable_catalogue.js`
- **durable_write** — the one way this fleet replaces a file it cannot afford to lose. `js_kernel/durable_write.js`
- **flush_system** — the `flush` operator verb: resets a bot to "fresh on a server". `js_kernel/flush_system.js`
- **wipe_system** — the `wipe` operator verb: forget one owner's places, so the human accountable for a crew can move their base. `js_kernel/wipe_system.js`
- **record_homes** — where this machine's run records live. `js_kernel/utils/record_homes.js`
- **node_module_homes** — the one answer to "where do the third-party node modules live on THIS machine". `js_kernel/utils/node_module_homes.js`

## F. Identity, voice and command

- **bot_mandate** — what species this process is, decided at birth and never again. A homesteader has no chat listener mounted at all, not a filtered one. `js_kernel/bot_mandate.js`
- **bot_voice** — a contractor says one thing and one thing only: whether it is available. `js_kernel/bot_voice.js`
- **operator_commands** — start / stop / flush / wipe and the bench verbs, as one implementation behind two transports (the per-bot console, and the overseer's broadcast). `js_kernel/operator_commands.js`
- **body_recovery** — the two acts of putting a dead body back on its feet, owned in one place. `js_kernel/body_recovery.js`
- **the foreman** — the in-game desk. A human in the world asks and a crew arrives where they are standing; everything is hired from inside the game and that is the only way. `foreman/` (foreman, foreman_channel, foreman_record, foreman_vocabulary, correction, overseer_door)
- **the overseer** — claim arbitration, which is its only decision; everything else it does is pure relay (Law 3). `overseer/` (overseer_brain, overseer_server, owner_memory, message_schema)
- **overseer_link** — the bot-side WebSocket client. `js_kernel/overseer_link.js`
- **crew_log** · **crew_board** — what the crew said, and what the crew agrees about. `custom_api/`

## G. Diagnostics and the boundary

- **watcher** — one story file per bot, three persisted levels. Every bot writes down what it **decided and why**, not only what happened to it. `js_kernel/watcher.js`
- **external_library_guard** — **the only `try` in the fleet.** Every legal catch is this one and no call site writes its own; `preflight.js` pass 4 proves it. `js_kernel/utils/external_library_guard.js`
- **rcon_link** — the one route to the server console. `js_kernel/utils/rcon_link.js`
- **signal_utils** · **fragment_utils** — the shared routing and fragment helpers. `js_kernel/utils/`

## H. Birth

- **start_bot.js** — the one birth. A bot exists because this ran.
- **start_overseer.js** — the referee alone.
- **start_auren.js** — the desk and the referee together; the one way in for a user.
- **master_core.js** — what a bot runs once it has been told who it is.
- **child_fleet** — how a parent process raises and holds bots. `js_kernel/utils/child_fleet.js`

---

## Maintenance

**On creating a mechanism:** add its line to its layer in the same commit. Name in bold-free plain text,
one clause for what it is the only way of doing, then the path.

**On deleting one:** delete the line in the same commit.

**On finding a mechanism that is missing from this file:** add it. That is not a favour to the registrar,
it is the only thing keeping the file worth reading.

### SUGGESTION — made once, 2026-09-10

This index has the failure mode every hand-kept list has: it reports green while going stale, and nothing
in the repository would notice. **It could be machine-checked cheaply.** A pass in `preflight.js` that
sweeps `js_kernel/`, `js_kernel/utils/`, `Thinking_fragments/` and `custom_api/` for files carrying a
`// module:` or `// fragment:` header and asserts each one's basename appears somewhere in this file would
catch the omission at the moment it is made, for roughly the cost of pass 3's existing walk. It would
DISCOVER rather than carry a list, which is the property `tools/README.md` requires of anything that earns
a permanent home there. Not built — the Architect decides whether this file earns a gate.
