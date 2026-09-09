// module: movement/place_authority — THE ONE PLACE ROUTE (Law 16). Every block this fleet lays lands here.
// The twin of dig_authority, and it sits beside it deliberately: those two functions are the complete
// set of ways this construct changes the world, so a rule about changing the world has exactly two homes.
//
// The raw place VERB lives here; the LOGIC stays in each executor — which item a blueprint token resolves
// to, whether a cell is already correct, station registration, pillar-footing, group expansion. Same split
// dig_authority draws, for the same reason: the verb is identical everywhere and the decision never is.
//
// ── WHY THIS EXISTS, AND IT IS NOT THE REASON dig_authority EXISTS ───────────────────────────────────
// Read this before assuming the two are symmetric, because the asymmetry is the whole point and a
// successor who assumes otherwise will "fix" the wrong half.
//
// `bot.dig()` is UNBOUNDED and OPTIMISTIC: it has no timeout, and it resolves off an AIR event mineflayer
// manufactures in its own world model, so a non-throwing dig is not evidence of anything. dig_authority
// exists to put a bound and a re-sense around that.
//
// `bot.placeBlock()` is neither. Verified against the installed mineflayer: `_genericPlace` writes the
// `block_place` packet and touches the world model NOT AT ALL — there is no local prediction — and
// `placeBlock` then waits on a real server `blockUpdate` for the destination cell with a 5000 ms timeout,
// REJECTING if it does not come and THROWING `No block has been placed` if the block is unchanged. So a
// placement is already server-verified and already bounded. **This module is therefore not a bound and
// not a lie-catcher.** Nothing here should be written as though it were.
//
// What it IS for — five things that were duplicated, missing, or wrong across the eight call sites this
// replaces, none of which is fixable at a call site because a call site cannot bind the next one:
//
//   1. THE COMBAT CHECKPOINT WAS ABSENT FROM EVERY PLACEMENT, and a place is a longer blind window than a
//      dig. dig_authority's own argument — "a dig is where the body goes blind… polling at the top of a
//      caller's iteration leaves a whole swing with no gate call in between" — applies harder here,
//      because `placeBlock` can legitimately sit for the full five seconds waiting on a server that is
//      lagging. Every caller that placed was already gating somewhere; none of them could gate INSIDE a
//      place. This closes the same window on the same argument.
//   2. THE SPAWN-PROTECTED SQUARE was eight copies of one rule. Eight copies of a rule is the fault
//      job_gates.js was built to remove, and a ninth call site added later would have been born ungated.
//      Here a placement cannot exist without passing it (Law 27 — the failing case cannot form inside the
//      thing that would have to form it).
//   3. THE AIM WAS WRONG IN TWO PLACES. A placement clicks the FACE of an anchor block, so the point to
//      look at is the anchor's face centre — `anchor.position + (0.5,0.5,0.5) + face*0.5`. build_executor
//      computed exactly that; farm_executor and mining_executor looked at the centre of the TARGET CELL
//      instead, which is a different point and a steeper angle on every non-top face. It mostly worked
//      because mineflayer re-aims correctly inside `_genericPlace` — meaning the fleet was paying for a
//      wrong look and being rescued by the library. One aim, computed once, correctly.
//   4. AN OPEN CONTAINER WINDOW BLOCKS `bot.equip`, and only build_executor closed one first. The other
//      seven inherited a failure whose symptom is "could not equip" with no mention of a window. Closing
//      is a no-op when none is open, so this is free everywhere else.
//   5. SNEAK RELEASE. A stranded sneak follows the body into whatever verb runs next. Every site that
//      sneaked used withCleanup for this; centralising it means a site that forgets cannot exist.
//
// ── WHAT IS DELIBERATELY *NOT* HERE ─────────────────────────────────────────────────────────────────
// No timeout of our own. mineflayer's is 5000 ms, it rejects rather than resolving, and a second bound
// stacked on top would be a redundant pathway that can only disagree with the first (Law 16). One caller
// (craft_handler) previously raced its own 5 s timer against a call that already had a 5 s timer; that
// copy is gone rather than reproduced here.
//
// No verdict beyond "the cell now holds something". What counts as the RIGHT something differs per caller
// — mining wants the exact item name, build wants to know whether a station appeared so it can register
// it, farm wants any non-air — and deciding that here would be usurping the asker's criterion (Law 25).
// The `after` block is returned so each caller applies its own test to the same sensed fact.

'use strict';

const watcher = require('@kernel/watcher');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');
const { isAir } = require('@utils/movement/terrain_predicates');
const { ensureNoOpenWindow } = require('@utils/movement/dig_authority');

// The settle before re-sensing. 200 ms was independently written into five files as STEP_WAIT_MS; this is
// that constant arriving at one home rather than a sixth copy. It is a SETTLE, not a timeout: mineflayer
// has already confirmed the server's block update by the time we return, and this only lets the local
// world model finish applying it before we read it back.
const PLACE_SETTLE_MS = 200;

// performPlace — THE ONE PLACE AUTHORITY.
//
//   bot      the body
//   pos      the cell the block should END UP in (Vec3) — what the caller cares about
//   anchor   the existing block being clicked (a prismarine Block, with .position)
//   face     the face vector of that anchor (Vec3) — anchor.position + face === pos
//   itemName the inventory item to place
//   tag      watcher scope for log attribution
//   opts.sneak   'auto' (default — sneak when the anchor is interactable, so the click places instead of
//                opening a chest/furnace UI), true (always — the locomotion callers, which are placing at
//                the edge of their own footing and must not step off), false.
//   opts.settleMs  override the settle above.
//
// Returns { ok, after, reason }:
//   ok      true only when the cell is non-air on a FRESH read after the place (Invariant B — the verdict
//           is the world, never the call returning). mineflayer already proved the server accepted it;
//           this proves what actually stands there, which is what every caller goes on to test.
//   after   the block now in the cell (or null) — the caller's own criterion is applied to this.
//   reason  why not, when ok is false. Always a stated cause, never a bare false (Law 13).
async function performPlace(bot, pos, anchor, face, itemName, tag = 'place_authority', opts = {}) {
  // Geometry the caller could not compute is an ENVIRONMENTAL answer, not a bug: evaluatePlacement
  // legitimately finds no reachable face for a cell that is walled in, and every caller already treated
  // that as "skip this cell". Soft-fail with the cause named, exactly as before.
  if (!anchor || !anchor.position || !face) {
    return { ok: false, after: null, reason: 'no anchor/face — nothing to place against' };
  }
  if (!itemName) {
    return { ok: false, after: null, reason: 'no item name resolved for this cell' };
  }

  // ── THE SPAWN-PROTECTED SQUARE ─────────────────────────────────────────────────────────────────
  // Placements are refused inside it exactly as breaks are. Enacted at the one place a block can be
  // laid, so no pathway — present or future — can route around it (Law 27).
  const { spawnProtectionVerdict } = require('@perception/spawn_protection');
  const spawnVerdict = spawnProtectionVerdict(bot, pos, 'place');
  if (!spawnVerdict.allowed) {
    watcher.warn(tag, spawnVerdict.why);
    return { ok: false, after: null, reason: 'spawn_protected' };
  }

  // ── THE COMBAT CHECKPOINT ──────────────────────────────────────────────────────────────────────
  // Same placement and same argument as dig_authority's: BEFORE the equip, because the equip and the
  // click are the span being covered and a checkpoint after them would leave exactly the window it
  // exists to close. Self-bypassing when battle_stations already holds the body, so combat's own
  // placements do not re-enter the gate that raised them. Never awaited for a value and may never
  // resolve — on a real threat battleStations abandons this caller (Law 15) and the placement is
  // discarded, which is correct: the block keeps, the fight does not.
  await require('@api/battle_stations').combatCheckpoint(bot, `place:${tag}`);

  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) {
    return { ok: false, after: null, reason: `no ${itemName} in inventory` };
  }
  if (!bot.heldItem || bot.heldItem.name !== itemName) {
    const equipped = await guardExternal(tag, `equip ${itemName}`, async () => {
      // Unconditional, and free when nothing is open: an open container window makes bot.equip fail with
      // a message that never mentions a window, which is the failure only build_executor was defended
      // against.
      if (bot.currentWindow) await ensureNoOpenWindow(bot, `equip ${itemName}`);
      await bot.equip(item, 'hand');
      await sleep(PLACE_SETTLE_MS);
    });
    if (!equipped.ok) return { ok: false, after: null, reason: `equip ${itemName} failed: ${equipped.reason}` };
  }

  // Sneak so a click on an interactable anchor PLACES against it instead of opening its UI. 'auto' asks
  // the block; the locomotion callers pass true because their anchor is their own footing edge.
  const sneakMode = opts.sneak === undefined ? 'auto' : opts.sneak;
  const shouldSneak = sneakMode === 'auto'
    ? require('@api/anchored_repair').isInteractable(anchor.name)
    : !!sneakMode;

  // THE AIM IS THE ANCHOR'S FACE CENTRE, not the target cell's centre — the click lands on a face.
  const faceCenter = anchor.position.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5));

  // withCleanup wrapping the guard, not a second catch: the sneak must be released on every exit —
  // placed, refused, or thrown — because a stranded sneak follows the body into the next verb.
  const place = await withCleanup(tag, 'place with sneak',
    () => guardExternal(tag, `lookAt/placeBlock ${itemName} at (${pos.x},${pos.y},${pos.z})`, async () => {
      await bot.lookAt(faceCenter);
      await sleep(80);                                   // let the head finish turning before the click
      if (shouldSneak) bot.setControlState('sneak', true);
      await bot.placeBlock(anchor, face);
    }),
    () => { if (shouldSneak) bot.setControlState('sneak', false); });

  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : PLACE_SETTLE_MS;
  await sleep(settleMs);
  const after = bot.blockAt(pos);

  if (!place.ok) {
    // mineflayer rejects with a real cause here — a 5 s timeout with no server update, `No block has been
    // placed`, or `must be holding an item`. Carry it rather than flattening it to false: it is the
    // difference between "the server refused" and "the reference block was wrong" (Law 13).
    return { ok: false, after, reason: `placeBlock refused: ${place.reason}` };
  }
  if (after && !isAir(after.name)) return { ok: true, after, reason: null };
  return { ok: false, after, reason: 'place returned but the cell is still air — the block did not stick' };
}

// A local sleep so this module does not pull fragment_utils in for one timer (fragment_utils reaches the
// station registry and the inventory lens; a movement primitive has no business loading either).
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  performPlace,
  PLACE_SETTLE_MS,
};
