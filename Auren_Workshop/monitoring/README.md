# `Auren_Workshop/monitoring/` — the three lenses that read the CAMERA STACK

> *"i think we should bring troubleshooting items into the public repo so other people can use it. but
> keep the recording parts out."* — Architect, 2026-09-10

**The lens stack moved into the bot on 2026-09-10. Three files stayed here, and this page is why.**
Everything else — `trace_monitor`, `trace_read`, and the thirteen lenses that read a bot's own trace —
now lives at **`Auren_Bot/monitoring/`**, and that folder's `README.md` and `LENSES.md` are the two
indexes. Look there first; this page only covers what did not travel.

## The rule that decided the split, and it is mechanical

**WHICH RECORD DOES THE LENS READ?**

- A **bot's own trace** (`fleet_logs/traces/watcher_*.jsonl`, the foreman's record, the boardroom) →
  troubleshooting → **it ships**, because a stranger whose fleet froze needs to read their own run and
  the alternative was mailing a 90,000-line file to the Architect.
- The **camera stack's records** (`fleet_logs/combat_witness/`, `fleet_logs/machine_load/`, the rig's
  vantage events) → recording → **it stays here**, because the camera stack is the Architect's own
  equipment and is not in the download at all. Shipping its reader would ship a flag that can only ever
  report an empty directory.

It is not a judgement about which lenses are worth having. Applied to a new lens tomorrow, the question
is the same one and it has one answer.

## What is here

| file | reads | reports |
|---|---|---|
| `camera_lens.js` | `fleet_logs/traces/watcher_camera_*.jsonl` | **the camera's run** — what the scout scanned, how each vantage was chosen (candidate pool, air-box/lens-box rejections, 30-degree relaxations, cone verdict), why every cut fired, and the holds where it looked and stayed (`--camera`). Reads the PARALLEL view, never the fleet one — see `trace_read.readCameraView` for why the two are kept apart |
| `combat_witness_lens.js` | `fleet_logs/combat_witness/combat_witness.jsonl` | the OUTSIDE observer's account of the same fights (`trace_monitor --witness`) — and the **cross-read**: it joins the observation to the `engage` lines `combat_lens` reads off the bot's trace, on the mob's entity id and a shared absolute clock, so a fight the bot never logged shows up as a row instead of as nothing |
| `machine_load_lens.js` | `fleet_logs/machine_load/*.jsonl` | **what the BOX was doing**, not what the fleet decided — GPU/VRAM/temperature/power, CPU and free RAM as p50/p95/max, plus how late a sample landed (`--machine-load`). The one lens that reads a record about the machine rather than about the bots, because camera windows scale with bot count and the GPU is the constraint nobody could previously measure. Reports LOAD and refuses to report smoothness: a hitch is a late frame and nothing outside the game process can see one (Law 25) |

## THERE IS STILL ONE ENTRY POINT, AND IT IS IN THE BOT (Law 16)

**Never run these three directly.** They are reached the same way as every other lens:

```
node .\Auren_Bot\monitoring\trace_monitor.js --camera
node .\Auren_Bot\monitoring\trace_monitor.js --witness
node .\Auren_Bot\monitoring\trace_monitor.js --machine-load
```

`trace_monitor` resolves this folder at the moment one of those three flags is used — `recordingLens()`
in `trace_monitor.js`, asking `recordingLensDir()` in `lens_paths.js`. Inside this repository the folder
is found and the lens runs exactly as before. Outside it, the flag answers with one sentence saying the
camera stack is not installed, because `MODULE_NOT_FOUND` naming a path two directories above somebody's
download is the wrong thing to hand a person who simply does not own a camera (Law 13 — a missing thing
is named, never dressed up as a crash in the caller).

These three require the bot's lens core across the boundary (`../../Auren_Bot/monitoring/trace_read`,
`report_formatting`, `combat_lens`). **That direction is the correct one and the only permitted one: the
workshop reads the bot, the bot never reads the workshop.** A require pointing the other way would put a
path to the Architect's private equipment inside a folder that ships.

## Where the rules live

The lens discipline itself — *a record is read only through its lens*, *if a lens cannot answer the
question that is a defect in the lens*, *no reader spells a record's path*, *no instrument keeps a record
across runs* — is stated once, in `Auren_Bot/monitoring/README.md`. It governs these three files too. It
is not restated here, because two copies of a standing rule drift the first time one is amended.
