// module: movement/dig_authority — THE ONE DIG ROUTE (Law 16). Every dig in this system lands here.
// Raw dig verbs shared by build_executor and mining_executor; the LOGIC (evaluatePlacement, station
// registration, group expansion) stays in each executor — only the verb lives here.
//
// digBounded is deliberately NOT exported: it is performDig's private bounded primitive. Exporting it
// would open a second dig route that skips the re-sense below — callers could dig, trust the optimistic
// resolve, and act on a block that was never actually removed. Keeping it module-private is what makes
// the re-sense unavoidable rather than merely recommended.

'use strict';

const watcher = require('@kernel/watcher');
const { isFluid } = require('@utils/gravity_utils');
const { sleep, equipBestToolForBlock, STATION_TYPES } = require('@utils/fragment_utils');
const { isAir, belowDepthFloor } = require('@utils/movement/terrain_predicates');
const { WORLD_DEPTH_FLOOR_Y } = require('@thinking/architect_config');
const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');

// A STATION IS NOT BREAKABLE BY THIS FLEET — STATION_TYPES, less the one name the Architect has since
// exempted (BREAKABLE_STATIONS, below).
//
// It began as three names (the furnace family) on the Architect's first ruling; he widened it the same day
// on the recommendation that followed: *"extend to all stations."* The day after, he took `crafting_table`
// back out. The list is therefore his, not derived — read the exemption note below before assuming the two
// sets should be identical again.
//
// WHY A PRICE WAS NEVER ENOUGH, and this is the wrong turn most likely to be retaken. A station was already
// covered twice: STATION_TYPES declares stations undiggable, and the route search charges
// PROTECTED_VOXEL_DETOUR_BUDGET for a blueprint voxel. Both are COSTS. A cost is payable, so a search with
// no cheaper detour buys the block and breaks it — and a caller that never consults the search does not
// even meet the price. That was the actual case: build_executor stands AT the cell, pathing nothing, and
// dug up its own correctly-placed furnace on a loop in front of the Architect. Only a refusal at the swing
// binds every caller, including ones not yet written (Law 27: the failing case cannot form inside the
// thing that would have to form it).
//
// WHAT THIS COSTS, stated because it is real and was accepted: nothing can clear a station standing in a
// cell the blueprint wants for something else. build_executor's pre-clear dig is refused there, and that
// cell cannot be corrected by the fleet — it needs a person. The trade is deliberate: a stall that says so
// is worth more than a loop that destroys correct work silently.
//
// isUnbreakable — the predicate, exported so the decision can be asked WITHOUT swinging. The bench needs
// this: the virtual body refuses to compute an action's outcome (it has no dig/lookAt, and giving it one
// would make it a simulator that confirms beliefs instead of finding bugs), so "stone is still breakable"
// cannot be shown by digging stone there. It is shown by asking the gate. No production caller — the
// refusal inside performDig is what binds behaviour, and a caller checking this first would be a second
// place deciding the same thing (Law 16).
//
// THE ONE EXEMPTION, and it is the Architect's own narrowing of his rule the day after he widened it
// (2026-08-31): *"crafting table isnt dug up. its a preference. dig with axe if you can, hands if not."*
//
// WHY IT HOLDS, in the game's own data rather than as a taste: the never-dig rule was born from a furnace
// destroyed by a bare hand — `furnace` carries `harvestTools`, so a wrong-tool break yields NOTHING and the
// block is gone for good. `crafting_table` carries none: its material is `mineable/axe` and it drops itself
// to an axe, a pickaxe, a sword or a fist alike. There is no way to break one wrongly, so the axe is a
// SPEED preference (equipBestToolForBlock already reaches for it and already falls back to the hand), and
// nothing about a crafting table needs a refusal to protect it. What the refusal DID cost was real: a
// crafting table standing in a cell the blueprint wants for something else could not be cleared by the
// fleet at all, and a person had to come and break it.
//
// SCOPED TO THE ONE BLOCK HE NAMED, deliberately. `chest`, `barrel` and `composter` also drop to any tool,
// so the same argument would reach them — and it is not made here, because the rest of the set is still
// under his original ruling and widening it is his call, not a generalisation to be inferred from one
// sentence about crafting tables (Law 21).
const BREAKABLE_STATIONS = new Set(['crafting_table']);
function isUnbreakable(name) { return STATION_TYPES.has(name) && !BREAKABLE_STATIONS.has(name); }

// Mineflayer leaves container windows open after chest/furnace use, which blocks the next
// bot.equip / bot.placeBlock — close it first.
async function ensureNoOpenWindow(bot, label = 'equip') {
  if (!bot || !bot.currentWindow) return;
  const w = bot.currentWindow;
  watcher.summary('dig_authority', `Closing window before ${label}: type=${w.type || 'unknown'}`);
  guardExternalSync('dig_authority', `closeWindow before ${label}`, () => {
    if (typeof bot.closeWindow === 'function') bot.closeWindow(w);
    else if (bot._client && typeof bot._client.write === 'function' && w.id != null) bot._client.write('close_window', { windowId: w.id });
  });
  let tries = 0;
  while (bot.currentWindow && tries < 8) { await sleep(80); tries++; }
}

// ── digBounded: the ONE dig authority (Law 16). Every dig in this system goes through here. ──
// mineflayer's bot.dig() HAS NO TIMEOUT: the call tail is a bare `await diggingTask.promise`
// (digging.js:209) and the sole resolve is an `onBlockUpdate` listener guarded by
// `if (newBlock?.type !== 0) return` (digging.js:196). No timer, no ceiling.
//
// WHY IT CAN HANG — an ABSENT CHUNK, and nothing else. The dig does NOT depend on the server to
// resolve: finishDigging calls bot._updateBlockState(pos, 0) (digging.js:158) → blocks.js:246-248
// world.setBlockStateId writes AIR *locally* → prismarine-world/src/worldsync.js:152-159 →
// _emitBlockUpdate fires `blockUpdate:${pos}` UNCONDITIONALLY (worldsync.js:65-70, no old!==new
// guard). The client manufactures its own AIR event and settles the promise. But worldsync.js:154 is
// `const chunk = this.getColumnAt(pos); if (!chunk) return` — a SILENT no-op. If the cell's chunk is
// absent from the client world at finishDigging time, nothing is ever emitted and the caller waits
// forever. It self-releases if the chunk loads back and the server's block_change lands.
//
// INSTANT-break blocks are the tell: they resolve locally at waitTime=0 with zero server involvement,
// so a hang cannot be dig SPEED and cannot be a missed server event. Duration is chunk
// RE-ACQUISITION time, not a dig property, and independent of hardness. Farm/tree work digs at the
// chunk frontier (find_buildingspot scans outward until it hits unloaded ground); base and shaft
// digs sit in long-loaded chunks — that geometry, not dig volume, is what exposes this.
//
// History, since it reads as an oversight otherwise: dig HAD a timeout — `bot.dig(block, [timeout],
// [callback])` from 0.0.14 — and upstream REMOVED it at 0.0.29, the same release that added
// bot.digTime(block). That is upstream declining to time the dig and handing over the primitive to
// price it yourself. This function is that contract, rebuilt. See mineflayer docs/history.md.
//
// The bound is a BACKSTOP, not a measurement. The failure is binary — chunk present (resolves in
// ~digTime) or absent (hangs) — so no budget "detects" it; the budget only has to exceed any honest
// dig. Derived from bot.digTime(block) x SLACK so it scales with tool/block/water/off-ground instead
// of aging into a hardcoded guess, and a legitimately slow dig is never falsely aborted. On timeout
// we abort mineflayer's stuck dig and let FRESH WORLD STATE return the verdict (Invariant B) — a
// stuck promise is not evidence the block survived; the common case is "promise stuck, work already
// done". Then hand the verdict to the caller's own retry/judge path (Law 13).
// TODO: gate on chunk presence — bot.blockAt(pos) !== null — before digging at all, and keep this
// bound only for a mid-dig unload. Aims at the actual cause.
const DIG_TIMEOUT_MIN_MS = 3000;    // floor — an instant block plus server round-trip, generously
const DIG_TIMEOUT_SLACK  = 3;       // budget = expected dig time x this …
const DIG_TIMEOUT_MAX_MS = 30000;   // … clamped here; past this the chunk is gone, not the block slow
const DIG_TIMED_OUT = Symbol('dig_timed_out');

// THE CAP MAY NEVER FALL BELOW THE ESTIMATE IT CAPS. `Math.min(MAX, expected * SLACK)` alone produced
// a budget SHORTER than the block's own break time whenever expected > MAX/SLACK, and then the abort
// fired at a fixed fraction of a dig that was progressing normally — every attempt, forever, with no
// retry count that could get through. The header above this block claims "a legitimately slow dig is
// never falsely aborted"; without this floor that claim was false.
//
// The cap's actual job is a mid-dig CHUNK UNLOAD, and a large `expected` is evidence of the opposite
// case — the tool/block/penalty maths ran and returned a real number, so the block is slow, not gone.
// The two multipliers say different things: SLACK (3x) is headroom over an estimate we believe;
// FLOOR (1.25x) is the minimum that lets a believed-slow dig finish at all. So the cap still bounds
// runaway slack, and can no longer contradict the estimate underneath it (Law 25 — the emitted verdict
// must be true against the criterion, and "did this block break" cannot be answered by a swing that
// was stopped at half time).
const DIG_TIMEOUT_ESTIMATE_FLOOR = 1.25;

async function digBounded(bot, block, tag = 'dig_authority') {
  if (!block) return false;
  const pos = block.position;

  const timed = guardExternalSync(tag, `digTime(${block.name})`, () => bot.digTime(block));
  let expected = timed.ok ? timed.value : 0;
  if (!Number.isFinite(expected)) expected = DIG_TIMEOUT_MAX_MS;   // unbreakable-by-tool → clamp, don't hang
  const budget = Math.max(DIG_TIMEOUT_MIN_MS,
                          Math.min(DIG_TIMEOUT_MAX_MS, expected * DIG_TIMEOUT_SLACK),
                          expected * DIG_TIMEOUT_ESTIMATE_FLOOR);

  const digPromise = bot.dig(block);
  digPromise.catch(() => {});   // the abort below rejects this; never surface it as unhandled

  // The race is guarded because bot.dig REJECTS on the ordinary refusals (out of reach, aborted,
  // block changed under the swing) — a real third-party boundary. A rejection is not the verdict
  // though: the caller re-senses the cell, so a refused dig and a hung dig both fall through to the
  // same fresh reading below (Invariant B).
  let timer = null;
  const raced = await guardExternal(tag, `dig ${block.name} at (${pos.x},${pos.y},${pos.z})`, () => Promise.race([
    digPromise.then(() => 'done'),
    new Promise(resolve => { timer = setTimeout(() => resolve(DIG_TIMED_OUT), budget); }),
  ]));
  clearTimeout(timer);
  if (raced.ok && raced.value !== DIG_TIMED_OUT) return true;
  if (!raced.ok) {
    const after = bot.blockAt(pos);
    return !after || after.name === 'air' || after.boundingBox === 'empty';
  }

  // Hung. Abort so mineflayer stops swinging and drops its listener. stopDigging() no-ops once
  // targetDigBlock is cleared (the instant-block case — finishDigging already ran), so also drop the
  // stale per-cell listener by hand, using mineflayer's own event-name interpolation.
  // Tradeoff (deliberate): this listener is exactly what WOULD have resolved the dig for free
  // if the chunk came back. We forfeit that on purpose — the caller gets a re-sensed verdict now and
  // moves on, rather than holding a signal open on a cell the world may never return (Law 13).
  guardExternalSync(tag, `stopDigging while aborting a hung dig at (${pos.x},${pos.y},${pos.z})`, () => bot.stopDigging());
  guardExternalSync(tag, `removeAllListeners while aborting a hung dig at (${pos.x},${pos.y},${pos.z})`, () => bot.removeAllListeners(`blockUpdate:${pos}`));

  const after = bot.blockAt(pos);
  const gone = !after || after.name === 'air' || after.boundingBox === 'empty';
  watcher.warn(tag, `dig_timeout ${block.name} at (${pos.x},${pos.y},${pos.z}) — no air blockUpdate in ${budget}ms (expected ${Math.round(expected)}ms). mineflayer's dig never resolved; aborted and re-sensed: block ${gone ? 'IS gone (promise stuck, work done)' : 'still standing'}.`);
  return gone;
}

// performDig: THE ONE DIG AUTHORITY (Law 16 — one capability, one implementation, one route).
// Equip → look → bounded dig → RE-SENSE. Nothing else may call bot.dig() or the bounded primitive:
// digBounded is private to this file precisely so no caller can dig without the verification below.
//
// WHY the re-sense: bot.dig() resolves optimistically — mineflayer's finishDigging writes AIR into
// its OWN world model the instant the dig timer elapses and resolves off that self-made event; the
// server is never in the loop (verified against prismarine-world's worldsync). So a
// non-throwing dig is NOT proof of removal. We sleep for a server revert, re-read the cell, and
// return true ONLY if it is now air/passable (Invariant B / Law 13 — a verified action confirms its
// effect against fresh state, never assumes it).
//
// KNOWN LIMIT (do not mistake this for complete): the re-sense reads bot.blockAt — the same
// client model that lied. It catches the reach/geometry class (the server reverts, and that revert
// lands). It does NOT catch a break the server REFUSES outright: no revert is ever sent, the model
// keeps the phantom AIR, and this returns a false true. That class is only visible via server-synced
// channels — an inventory delta, or failure-to-move. Callers whose job is collection must check their
// own `have` delta; this function cannot do it for them (a navigator clearing a cell gains no item and
// would read as failure).
//
// ONE MEMBER OF THAT CLASS IS NOW HANDLED, AND ONLY BY PREDICTION: spawn-protection. It cannot be
// SENSED after the fact for the reason above, so it is refused BEFORE the swing by the gate below,
// off the world spawn the server states at login plus the radius the launcher asserts. Protection
// plugins and land claims remain in the unhandled part of this class — the fleet holds no rule for
// them, so they still produce the phantom-AIR false true this paragraph describes.
//
// opts.equip: 'best' (default) equips the best tool for the block. 'none' leaves the hand EXACTLY as
// the caller set it — required by callers whose DROPS depend on the held item (seed_picker needs
// bare hands for seeds; harvest_executor unequips when no tool fits; craft_handler wants its
// pickaxe). Equipping over them would silently change what the block drops.
// tag = watcher scope for log attribution.
//
// Dig tags whose digs are LOCOMOTION/pillar infrastructure, exempt from the water-escape below:
// crossing water is normal movement, and the escape's own goTo re-dispatches locomotion (a duplicate
// signal if fired inside an active navigator signal — Law 4). Every executor work-dig uses its own
// tag ('build_executor'/'farm_executor'/'mining_executor'/tree_feller), so this fails closed — an
// unlisted tag escapes. This is the successor to battle_stations' retired `source==='locomotion'`
// exemption, keyed on the caller's dig tag.
//
// THESE ARE MODULE NAMES AND THEY MUST TRACK THE SPLIT. Before the movement folder existed, drive and
// scaffold both dug under the single tag 'movement_utils' and one entry covered both. They now tag
// with their own names, so BOTH must be listed — miss one and its locomotion digs start firing the
// water escape from inside an active navigator signal, which is the Law 4 duplicate the exemption
// exists to prevent. The default is deliberately a NON-exempt name so an untagged caller fails closed.
const LOCOMOTION_DIG_TAGS = new Set(['navigator', 'drive', 'scaffold_movement']);
async function performDig(bot, pos, block, tag = 'dig_authority', opts = {}) {
  // Precondition gate — dig only removes a SOLID block, so refuse air and liquid UP FRONT and report
  // it, instead of swinging and paying for the failure at the bottom. This is the dig-side symmetry of
  // placement's "check the target before you act". Two failure classes were being paid for late:
  //   • liquid — bot.dig(water/lava) NEVER resolves: a fluid emits no air blockUpdate, so every
  //     attempt rode digBounded's full 30s clamp before aborting. Water is not tool-breakable —
  //     digging it is a category error, not a slow dig, so no budget can fix it; only refusing to
  //     swing can.
  //   • air — nothing to break. Callers already pre-guard this; owning the check here means none must.
  // Contract is UNCHANGED (false = "cell not cleared"), so every caller inherits the fix with no edit
  // (Law 16): one that stays dumb just skips/doesn't-count; one that wants to act on the fail already
  // holds `block` and can see the liquid to displace it. Do NOT downgrade this to a silent skip — the
  // warn is the caller's evidence that a dig was refused, not lost (Law 5/13).
  if (!block || isAir(block.name)) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — nothing to dig (air/empty).`);
    return false;
  }
  if (isFluid(block.name)) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} is liquid, not tool-breakable; caller must displace, not dig.`);
    return false;
  }
  // THE DEPTH FLOOR (architect_config WORLD_DEPTH_FLOOR_Y), as a third precondition refusal — a cell
  // below it is treated as bedrock: not tool-breakable at any tier, so the swing is refused rather
  // than paid for. The route search already deletes these cells, so nothing SHOULD arrive here; this
  // is the second gate for every dig that does not come from a route — a combat terrain errand, a
  // harvest, a mining cell — none of which consult A* before swinging. Same contract as the two gates
  // above (false = "cell not cleared"), so every caller inherits it with no edit (Law 16).
  //
  // KEYED ON THE BODY, NOT THE CELL ALONE: a bot already below the floor may dig, because digging is
  // how it climbs out and a blanket refusal would entomb it. The rule bars going down, not coming up.
  if (belowDepthFloor(pos.y) && !belowDepthFloor(bot?.entity?.position?.y ?? pos.y)) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — below the depth floor (y<${WORLD_DEPTH_FLOOR_Y}); that layer is treated as bedrock.`);
    return false;
  }
  // A STATION IS NOT BREAKABLE BY THIS FLEET. Stated as a fact about the block rather than a rule about a
  // caller, and enacted at the one place a block can be broken — so there is nothing to enforce and no
  // pathway, present or future, that can route around it (Law 27: the failing case does not exist inside
  // the thing; Law 16: this function is the whole dig surface).
  //
  // The set and the whole argument live on isUnbreakable at the top of this file — including what the
  // refusal costs, which is real: a station standing where the blueprint wants something else can no
  // longer be cleared by the fleet at all.
  if (isUnbreakable(block.name)) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} is a station and stations are never dug: a station is always a blueprint voxel. Whatever wanted this cell must route around it, not through it.`);
    return false;
  }
  // ── THE SPAWN-PROTECTED SQUARE, and it is the one refusal here that the world will not confirm ────
  // Every other gate above refuses something the world would also stop, loudly, if we swung anyway. This
  // one refuses something the SERVER refuses SILENTLY: inside the square it drops the break and sends
  // nothing back, so the re-sense at the bottom of this function reads the same client model that
  // already wrote optimistic AIR and returns a false `true`. That is the KNOWN LIMIT named in this
  // function's header, and this is the gate that closes it — not by sensing harder, which is
  // impossible from the client, but by knowing the rule and not swinging.
  //
  // AT THE SWING, because this function is the whole dig surface (Law 16) and a refusal here binds every
  // caller including ones not yet written (Law 27 — the failing case cannot form inside the thing that
  // would have to form it). The selection layers above also drop protected candidates, which is what
  // makes the fleet plan around the square rather than repeatedly discover it; this is the floor beneath
  // all of them, for the digs that consult no scanner at all — a combat terrain errand, a harvest, a
  // navigator clearing a cell.
  //
  // NOT KEYED ON OP STATUS. The server would let an op'd bot through; the fleet does not (Invariant E,
  // Law 19). The argument lives on the module.
  const { spawnProtectionVerdict } = require('@perception/spawn_protection');
  const spawnVerdict = spawnProtectionVerdict(bot, pos, 'dig');
  if (!spawnVerdict.allowed) {
    watcher.warn(tag, spawnVerdict.why);
    return false;
  }
  // No work-dig while the body bobs. A dig at the water surface is unreliable —
  // the bob moves the body between look and swing (the chop-the-tree-while-bouncing failure) — so a
  // work-dig-in-water takes battle_stations over, swims to land, and abandons the caller to replan from
  // solid ground (Law 15). This REPLACES the retired blanket water gate on battleStations; placing while
  // bobbing is now allowed (pillarStep bob-place), only digging escapes. LOCOMOTION digs are exempt
  // (LOCOMOTION_DIG_TAGS): crossing water is normal movement, and the escape's own goTo re-dispatches
  // locomotion, so firing it inside an active navigator signal is a duplicate signal (Law 4) — the same
  // exemption the removed `source==='locomotion'` check gave, keyed here on the caller's dig tag. The
  // escape never resolves (it abandons), so `return`ing it freezes this caller's line as intended.
  if (opts.swimEscape !== false && !LOCOMOTION_DIG_TAGS.has(tag) && bot?.entity?.isInWater) {
    const { escapeWaterToLand } = require('@api/battle_stations');
    return escapeWaterToLand(bot, `performDig(${tag}) refused at (${pos.x},${pos.y},${pos.z}) — cannot dig while bobbing`);
  }
  // ── THE COMBAT CHECKPOINT ─────────────────────────────────────────────────────────────────────────
  // Every movement/action primitive carries this inline check rather than each caller polling for
  // combat itself: if battle_stations already holds the body the check is a no-op, otherwise it is the
  // one place a threat can interrupt.
  //
  // HERE RATHER THAN IN THE CALLERS because a dig is where the body goes blind. Polling at the top of
  // a navigator STEP or the top of a drop_collector ITERATION leaves a whole dig — which can run
  // seconds long — with no gate call in between, so incoming damage goes unanswered for the duration
  // of the swing. Every caller that dug was already gating; none of them could gate inside a dig.
  //
  // BEFORE THE EQUIP, not after: the equip and the swing are the span being covered, and a checkpoint
  // that ran after them would leave exactly the window it exists to close.
  //
  // SELF-BYPASSING. combatCheckpoint returns immediately when battle_stations already holds the body, so
  // combat's own digs — the escape corridor, the retreat carve — do not re-enter the gate that raised
  // them, avoiding recursion; the latch answering it predates this call.
  //
  // NOT AWAITED FOR A VALUE, and it may never resolve: on a real threat battleStations abandons this
  // caller to recursive_judge (Law 15) and the dig is discarded mid-swing. That is correct — the block
  // keeps, the fight does not — and it is why this is `await`ed rather than fired and forgotten, so the
  // dig cannot continue on a body that has been dragged away from the target (Invariant B).
  await require('@api/battle_stations').combatCheckpoint(bot, `dig:${tag}`);

  // Unguarded: equipBestToolForBlock keeps a boundary on each of its two mineflayer calls and answers
  // null when it cannot equip, so a throw out of it is a defect in our tool classification — and the
  // guard that stood here turned that defect into "skipping dig", which is how a bot mines nothing all
  // run and reports only refusals (Law 13).
  if (opts.equip !== 'none') await equipBestToolForBlock(bot, block, tag);

  // Only the aim is a boundary. digBounded owns its own timeout and returns a verdict; the verdict this
  // function owes its caller comes from RE-SENSING the cell below, never from the dig call returning.
  if (!(await guardExternal(tag, `lookAt dig target (${pos.x},${pos.y},${pos.z})`, () => bot.lookAt(pos.offset(0.5, 0.5, 0.5)))).ok) return false;
  await digBounded(bot, block, tag);                 // bounded — never hang the signal on one cell
  await sleep(100);                                  // let a server-side revert (rejected break) land
  const after = bot.blockAt(pos);
  if (!after || after.name === 'air' || after.boundingBox === 'empty') return true;
  watcher.warn(tag, `Dig did not take at (${pos.x},${pos.y},${pos.z}): ${after.name} still solid after dig — unaccepted break (out of reach / obstructed).`);
  return false;
}

// ── SECTION 11b: Combat Geometry (strike-and-fade calculators) ──
// Pure world-in/verdict-out geometry for the engagement ladder (combat refurbish §3). Kinematic
// timing lives in attack_cadence_calculator; these two need terrain/LoS, so they reuse this file's single-
// source predicates (Law 16 — no forked terrain logic). Re-run on fresh world state, never cached
// (Invariant B): the mob and the ground both move.

// Constants — creeper melee reach (blocks) and the default straight-line retreat corridor length.

module.exports = {
  ensureNoOpenWindow,
  performDig,
  isUnbreakable,
};
