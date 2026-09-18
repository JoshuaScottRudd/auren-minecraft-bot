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

const Vec3 = require('vec3');
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
//   opts.state     the block state the cell must END UP showing, e.g. { facing: 'east', half: 'bottom' }.
//                  Present → THE FACING PLACE (below): facing_aim chooses the clicked block, face, cursor
//                  and the rotation to report, and `anchor`/`face` are not used. Absent → the face-centre
//                  place, unchanged.
//
// Returns { ok, after, reason, state }:
//   ok      true only when the cell is non-air on a FRESH read after the place (Invariant B — the verdict
//           is the world, never the call returning). mineflayer already proved the server accepted it;
//           this proves what actually stands there, which is what every caller goes on to test.
//   after   the block now in the cell (or null) — the caller's own criterion is applied to this.
//   reason  why not, when ok is false. Always a stated cause, never a bare false (Law 13).
//   state   only when opts.state was given: { wanted, got, ok } read off the placed block. A wrong state is
//           NOT folded into `ok` — the cell does hold the block — and the caller decides what a wrong
//           facing means for it (Law 25).
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

  // THE SPAWN-PROTECTED SQUARE IS NOT CHECKED HERE ANY MORE (Architect 2026-09-15). Every cell inside it
  // reads as BEDROCK through `spawn_protection.maskWorldReads`, so the cell is never empty, never a
  // candidate, and never reaches a placement: the occupancy check below refuses it as an occupied cell,
  // which is the truth the mask installs rather than a second rule about spawn.

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

  if (opts.state) return placeWithState(bot, pos, itemName, tag, opts);

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
      if (shouldSneak) setSneak(bot, true);
      await bot.placeBlock(anchor, face);
    }),
    () => { if (shouldSneak) setSneak(bot, false); });

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

// ── THE FACING PLACE ────────────────────────────────────────────────────────────────────────────────
// For a block whose facing matters. Three faults made June's attempt impossible (scratchpad §3.2), and
// each has its answer here:
//   1. `bot.placeBlock` re-aims at the clicked face's centre before it sends, erasing any chosen look. The
//      click goes through `_placeBlockWithOptions` with forceLook 'ignore', so the library never turns the
//      head (Architect 2026-09-16: the library's head-turn stays off; the bot aims itself).
//   2. A forced look is not sent until the next physics tick, and the server copies the body's yaw to the
//      head yaw (what chests read) only when it ticks the player. AIM_SETTLE_TICKS covers both — 4 client
//      ticks measured with zero lag misses over 415 places (§5.2).
//   3. Direction tables were written by hand and had an axis backwards. The yaw here is computed from the
//      direction vector with the same formula `bot.lookAt` uses, so there is no table to get wrong.
// The reported yaw is snapped onto the rule's direction for the click, from wherever the body stands, and
// the click may land on a face the eye does not see — the Architect's Law 19 ruling is quoted in
// facing_aim's header. So facing never costs a stand: an anchor that reaches a cell can set any facing in it.
const AIM_SETTLE_TICKS = 4;

// opts.block names the block the cell must show when it differs from the item placed (a torch item makes a
// wall_torch on a side face, an oak_sign item an oak_wall_sign). The rule is the block's; the item is held.
async function placeWithState(bot, pos, itemName, tag, opts) {
  const facingAim = require('@utils/movement/facing_aim');
  const blockName = opts.block || itemName;
  const aim = facingAim.findAim(bot, pos, blockName, opts.state);
  const wanted = aim.state || opts.state;
  if (!aim.ok) return { ok: false, after: bot.blockAt(pos), reason: aim.reason, state: { wanted, got: null, ok: false } };
  const ref = `${aim.family}: ${aim.anchor.name}@(${aim.anchor.position.x},${aim.anchor.position.y},${aim.anchor.position.z}) face(${aim.face.x},${aim.face.y},${aim.face.z}) yaw ${(aim.yaw * 180 / Math.PI).toFixed(1)} pitch ${(aim.pitch * 180 / Math.PI).toFixed(1)}${aim.sneak ? ' sneak' : ''}`;

  // Sneak is part of the state for a chest (it keeps one single beside another) and is released on every
  // exit, the same guarantee the face-centre place gives.
  const place = await withCleanup(tag, 'state place with sneak',
    () => guardExternal(tag, `state place ${blockName} ${JSON.stringify(wanted)} at (${pos.x},${pos.y},${pos.z})`, async () => {
      if (aim.sneak) setSneak(bot, true);
      await bot.look(aim.yaw, aim.pitch, true);
      await bot.waitForTicks(AIM_SETTLE_TICKS);
      await bot._placeBlockWithOptions(aim.anchor, aim.face, { forceLook: 'ignore', delta: aim.delta, swingArm: 'right' });
    }),
    () => { if (aim.sneak) setSneak(bot, false); });

  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : PLACE_SETTLE_MS;
  await sleep(settleMs);
  let after = bot.blockAt(pos);
  if (!place.ok) return { ok: false, after, reason: `placeBlock refused: ${place.reason} [${ref}]`, state: { wanted, got: null, ok: false } };
  if (!after || isAir(after.name)) return { ok: false, after, reason: `place returned but the cell is still air — the block did not stick [${ref}]`, state: { wanted, got: null, ok: false } };

  // OPEN IS A USE, NOT A PLACEMENT. A trapdoor, door or gate always lands closed; one right-click opens it.
  // It is sent the same way the place was — the rotation snapped, then the click with no library re-aim —
  // because opening reads the look too: a fence gate opened by a player looking against its facing swings
  // round to face the other way (measured: a south gate opened from its south side read north). The look
  // for the use is the block's own facing. Read back after each click, at most USE_ATTEMPTS, and only while
  // it still reads closed, so a click the server did not act on is retried and an open block is never shut.
  if (aim.use) {
    const facing = after.getProperties().facing;
    const useYaw = facing ? Math.atan2(-({ east: 1, west: -1 }[facing] || 0), -({ south: 1, north: -1 }[facing] || 0)) : aim.yaw;
    for (let attempt = 1; attempt <= USE_ATTEMPTS && String(after.getProperties().open) !== 'true'; attempt++) {
      await waitNoSneak(bot);
      const used = await guardExternal(tag, `open ${blockName} at (${pos.x},${pos.y},${pos.z})`, async () => {
        await bot.look(useYaw, 0, true);
        await bot.waitForTicks(AIM_SETTLE_TICKS);
        await bot._genericPlace(after, new Vec3(0, 1, 0), { forceLook: 'ignore', delta: new Vec3(0.5, 0.5, 0.5), swingArm: 'right' });
      });
      await sleep(settleMs);
      after = bot.blockAt(pos);
      if (!used.ok) return { ok: true, after, reason: null, state: { wanted, ...stateOf(facingAim, after, wanted) }, aim: `${ref} | open refused: ${used.reason}` };
    }
  }
  return { ok: true, after, reason: null, state: { wanted, ...stateOf(facingAim, after, wanted) }, aim: ref };
}
const USE_ATTEMPTS = 2;

function stateOf(facingAim, block, wanted) {
  const read = facingAim.stateMatches(block, wanted);
  return { got: read.got, ok: read.ok };
}

// setSneak — the ONE way this route crouches. mineflayer 4.39 sends sneak as `player_input.shift` on every
// version that has that packet (1.21.3+), but until 1.21.6 the server's SHIFT KEY — what a click reads as
// "secondary use" — is still set by the `entity_action` press/release-shift command, not by that input.
// So on 1.21.3–1.21.5 a mineflayer sneak crouches nothing the click can see. Measured 2026-09-16 on the
// fleet's then-1.21.5: a chest placed "sneaking" beside a same-facing chest joined it as `left`. The
// legacy command is sent alongside wherever the protocol still numbers it (no string mapper = before
// 1.21.6).
// WHICH BRANCH THE FLEET IS ON NOW (checked 2026-09-17, when it moved to 26.1): the OTHER one.
// `entityActionUsesStringMapper` is FALSE on 1.21.5 and TRUE on 26.1, so the legacy write below no
// longer fires at all and `player_input.shift` carries the crouch on its own — which is the whole point
// of the flag, and why this function needed no edit for the upgrade. Read the paragraph above as the
// reason the branch EXISTS, not as what happens today. The 26.1 side is UNVERIFIED live: the chest-join
// re-test was not run, and a wrong result there is silent (a joined chest is not an error), so nobody
// should treat "the soak passed" as evidence for it.
function setSneak(bot, on) {
  bot.setControlState('sneak', on);
  if (!bot.supportFeature('entityActionUsesStringMapper')) {
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: on ? 0 : 1, jumpBoost: 0 });
  }
}

// A use while the sneak release is still in flight would place against the block instead of opening it.
async function waitNoSneak(bot) {
  if (bot.getControlState('sneak')) setSneak(bot, false);
  await bot.waitForTicks(2);
}

// A local sleep so this module does not pull fragment_utils in for one timer (fragment_utils reaches the
// station registry and the inventory lens; a movement primitive has no business loading either).
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  performPlace,
  PLACE_SETTLE_MS,
};
