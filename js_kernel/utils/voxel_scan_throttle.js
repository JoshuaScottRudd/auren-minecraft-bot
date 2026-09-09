// voxel_scan_throttle — the ONE cooperative pacer for any scan that reads hundreds+ of voxels
// (site search, biome sweep, mining survey, blueprint overlay…). Reused, never re-invented (Law 16).
//
// A heavy scan that runs to completion inside a single tick starves the event loop — the server tick,
// this bot's physics/packets, and every other bot in the fleet all wait until the scan returns. This
// spreads the scan across macrotasks: run a burst, cede control so those processes get a slice, resume.
// A search that takes longer but never interrupts the run stream beats a fast one that stalls it, so
// throttling is what makes an uncapped (whole-loaded-area) search safe — the construct does not hog the
// shared world's tick just because it can (Law 19).
//
// TIME-SLICED, not count-batched. Yielding every N pace() calls is the wrong meter: one pace() call is a
// wildly different amount of work per caller — a building-footprint read covers hundreds of voxels, a
// cheap cell read covers ~2 — so a fixed batch count over- or under-yields depending on the caller, and
// every new scan has to hand-tune its own. The resource actually being protected is TIME (the server
// tick), so meter time directly: run a burst for up to one tick, then yield ONE macrotask. Whatever a
// caller can do in that window is one slice — self-normalizing, no per-caller batch to guess (Law 16).
// A slice is bounded above by one tick so the loop never blocks the shared world longer than a tick
// between yields. TRADE: a full-tick slice uses most of a core during a scan and yields only briefly
// between slices — correct for a one-shot siting scan where speed is the point; a fleet scanning heavily
// all at once would want a lower sliceMs to widen the yields.
//
//   const pace = makeScanThrottle();              // yield after ~one 50ms tick of work
//   for (const cell of manyCells) { doWork(cell); await pace(); }
//
// pace() is a bare clock read between yields (near-free), and awaits a real macrotask only at the slice
// boundary, where mineflayer gets a full turn. It never throws and never rejects — its only effect is to
// occasionally yield.

const TICK_MS = 50;   // one Minecraft server tick. A slice is one tick of work.

// makeScanThrottle — returns a `pace()` closure with private state.
//   sliceMs — max wall-clock of a synchronous burst before ceding a macrotask. Default one tick (50ms).
//             LOWER it (gentler, more frequent yields) only when many scans may run at once and the tick
//             needs more of the gap; RAISE it above a tick only with a deliberate reason (it then blocks
//             the shared world longer than a tick).
//   restMs  — how long to sleep at the boundary. 0 already yields a full macrotask (setTimeout clamps it
//             up), which is enough to let a tick run; raise it only to deliberately slow a scan further.
//   bot     — OPT-IN combat gate: a bulk scan is exactly the long blind window a threat-detection gate
//             exists to close, so pass a bot and the pacer polls battle_stations at its slice boundaries;
//             omit it and the pacer is exactly what it was.
//   source  — the tag handed to battleStations (e.g. 'locomotion'), forwarded verbatim.
//   combatEveryMs — how often the gate may actually be asked. NOT every boundary: a boundary arrives
//             every ~50ms and each gate call raycasts every hostile in the aggro radius, so polling
//             per-slice would cost dozens of full threat scans a second inside a long search.
const COMBAT_POLL_MS = 500;

function makeScanThrottle(opts = {}) {
  const sliceMs = Math.max(1, opts.sliceMs || TICK_MS);
  const restMs  = Math.max(0, opts.restMs  || 0);

  // The gate belongs in the pacer and not in each scan loop: every long-running voxel job in the fleet
  // already awaits this one function at its slice boundary, which IS the definition of "the loop is at a
  // safe point to yield" — and a safe point to yield is exactly a safe point to be interrupted. Putting
  // the check anywhere else means re-deriving that safe point per caller (Law 16). Without it, a bot
  // inside one long search/scan is blind to a live threat for the whole span of that search.
  //
  // A threat never returns, and that is correct: battleStations abandons its caller to recursive_judge
  // on a real engagement (Law 15) — the promise below never resolves, so the search that awaited it is
  // discarded mid-iteration and a fresh chain plans from the current world. Do NOT "fix" that with a
  // timeout or a resolve-anyway: a search that resumes after the bot has been dragged into a fight is
  // computing a route for a body that has moved (Invariant B).
  const bot = opts.bot || null;
  const source = opts.source || null;
  const combatEveryMs = Math.max(0, opts.combatEveryMs ?? COMBAT_POLL_MS);

  let sliceStart = Date.now();
  let lastCombatAt = Date.now();   // starts now: the caller just checked its own gate to get here

  return function pace() {
    if (Date.now() - sliceStart < sliceMs) return Promise.resolve();      // cheap path: still inside this tick's slice
    return new Promise(resolve => setTimeout(resolve, restMs))            // boundary: cede a macrotask…
      .then(() => {
        if (!bot || Date.now() - lastCombatAt < combatEveryMs) return;
        lastCombatAt = Date.now();
        // Required lazily: this is a leaf utility and battle_stations pulls in the perception + signal
        // stack, which would make a load-time cycle through pathfinding_utils. Same lazy-require pattern
        // the fragments already use for the signal bus.
        //
        // Routed THROUGH combatCheckpoint, not straight at the gate: the primitives carry this same poll,
        // and two independent clocks would double-scan — an A* that polled here would not stop the first
        // dig after it from polling again. combatCheckpoint holds ONE process-wide clock, so every span
        // shares a budget instead of each keeping its own (Law 16). The local `lastCombatAt` above stays
        // as this pacer's own rate limit — it decides how often to ASK; the checkpoint decides whether
        // asking is due. It also carries the `engaging`/`escaping` bypass, which this call site never had.
        const { combatCheckpoint } = require('@api/battle_stations');
        return combatCheckpoint(bot, source);
      })
      .then(() => { sliceStart = Date.now(); });                         // …then start the next slice's clock fresh
  };
}

// makeVoxelScan — the front door every bulk scan goes through. One call hands a scanner both halves of
// what it needs: the pacer that keeps it from starving the tick, and a reader that answers exactly the
// questions it declared and nothing more.
//
//   const scan = makeVoxelScan(bot, { needs: ['type'] });
//   for (const cell of cells) { if (scan.isWalkable(x, y, z)) …; await scan.pace(); }
//
// Pacing and reading are two verbs, so they are two modules (Law 0) — makeScanThrottle above,
// makeVoxelReader in voxel_reader.js. Fusing their implementations would make one fragment that both
// waits and reads. But a scanner needs both together, and leaving each caller to wire them up separately
// is how per-caller readers proliferate. So: one composition point, two implementations, a caller that
// names its criteria once (Law 16).
//
// `needs` is the whole point — see voxel_reader's header. Declare ['type'] and reads come from the
// per-number table; declare a light level and you get the full bot.blockAt, because that is the only
// truthful way to answer it. Which path you got is on `.fast`, never hidden.
function makeVoxelScan(bot, opts = {}) {
  const { makeVoxelReader } = require('@utils/voxel_reader');
  const reader = makeVoxelReader(bot, opts);
  // The pacer defaults to arming its combat gate with this bot, since a bulk scan is exactly the long
  // blind window the gate exists to close. A caller with no live body behind the scan passes
  // combatGate:false, as the benches do.
  const pace = makeScanThrottle(opts.combatGate === false
    ? { sliceMs: opts.sliceMs, restMs: opts.restMs }
    : { sliceMs: opts.sliceMs, restMs: opts.restMs, bot, source: opts.source || 'voxel_scan' });
  return Object.assign(Object.create(reader), { pace, reader });
}

module.exports = { makeScanThrottle, makeVoxelScan };
