// THE ONE PLACE ROUTE (Law 16). Every block this fleet lays lands here. The twin of dig_authority: those
// two functions are the complete set of ways this construct changes the world.
//
// The raw place VERB lives here; the LOGIC stays in each executor — which item a blueprint token resolves
// to, whether a cell is already correct, station registration, pillar-footing, group expansion. Same split
// dig_authority draws: the verb is identical everywhere, the decision never is.
//
// `bot.dig()` is unbounded and optimistic — no timeout, and it resolves off an AIR event mineflayer
// manufactures in its own world model — so dig_authority exists to put a bound and a re-sense around it.
// `bot.placeBlock()` is neither: `_genericPlace` writes the packet with no local prediction, then
// `placeBlock` waits on a real server `blockUpdate` with a 5000 ms timeout, rejecting or throwing on
// failure. A placement is already server-verified and already bounded, so this module is not a bound and
// not a lie-catcher.
//
// What it unifies, none of which a call site can bind on its own:
//   1. A combat checkpoint before every placement — a place can legitimately hold the full five seconds
//      waiting on a lagging server, a longer blind window than a dig.
//   2. The spawn-protected square, checked once instead of once per call site (Law 27 — the failing case
//      cannot form inside the thing that would have to form it).
//   3. The aim at the anchor's face centre — `anchor.position + (0.5,0.5,0.5) + face*0.5` — computed once,
//      correctly, for every caller.
//   4. Closing an open container window before `bot.equip`, which otherwise fails with no mention of a
//      window.
//   5. Sneak release through `withCleanup`, so a site that forgets to release cannot exist.
//
// ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────────────────────────────
// No timeout of our own: mineflayer's 5000 ms already rejects, and a second bound stacked on top would be
// a redundant pathway that can only disagree with the first (Law 16).
//
// No verdict beyond the cell now holding something. What counts as the right something differs per
// caller, and deciding that here would be usurping the asker's criterion (Law 25). The `after` block is
// returned so each caller applies its own test to the same sensed fact.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');
const { isAir } = require('@utils/movement/terrain_predicates');
const { ensureNoOpenWindow } = require('@utils/movement/dig_authority');

// The settle before re-sensing, held once here. It is a SETTLE, not a timeout: mineflayer has already
// confirmed the server's block update by the time we return; this only lets the local world model finish
// applying it before we read it back.
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
// The block leaving the pocket is read by the item book around the whole act, with the cell it went to.
async function performPlace(bot, pos, anchor, face, itemName, tag = 'place_authority', opts = {}) {
  return require('@kernel/item_book').during('place', 'placed',
    () => _place(bot, pos, anchor, face, itemName, tag, opts),
    { cell: [pos.x, pos.y, pos.z] });
}

async function _place(bot, pos, anchor, face, itemName, tag, opts) {
  // Geometry the caller could not compute is an ENVIRONMENTAL answer, not a bug: evaluatePlacement
  // legitimately finds no reachable face for a cell that is walled in, and every caller already treated
  // that as "skip this cell". Soft-fail with the cause named, exactly as before.
  if (!anchor || !anchor.position || !face) {
    return { ok: false, after: null, reason: 'no anchor/face — nothing to place against' };
  }
  if (!itemName) {
    return { ok: false, after: null, reason: 'no item name resolved for this cell' };
  }

  // THE SPAWN-PROTECTED SQUARE IS NOT CHECKED HERE. Every cell inside it reads as BEDROCK through
  // `spawn_protection.maskWorldReads`, so it is never empty, never a candidate, and never reaches a
  // placement — the occupancy check below refuses it as occupied, the truth the mask installs.

  // ── THE COMBAT CHECKPOINT ──────────────────────────────────────────────────────────────────────
  // Placed before the equip so the whole equip-and-click span is covered. Self-bypassing when
  // battle_stations already holds the body, so combat's own placements do not re-enter the gate that
  // raised them. Never awaited for a value and may never resolve — on a real threat battleStations
  // abandons this caller (Law 15) and the placement is discarded: the block keeps, the fight does not.
  await require('@api/battle_stations').combatCheckpoint(bot, `place:${tag}`);

  const cleared = await clearCell(bot, pos, tag);
  if (!cleared.ok) return { ok: false, after: bot.blockAt(pos), reason: cleared.reason };

  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) {
    return { ok: false, after: null, reason: `no ${itemName} in inventory` };
  }
  if (!bot.heldItem || bot.heldItem.name !== itemName) {
    const equipped = await guardExternal(tag, `equip ${itemName}`, async () => {
      // Free when nothing is open: an open container window makes bot.equip fail with a message that
      // never mentions a window.
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
    () => guardExternal(tag, `lookAt/placeBlock ${itemName}`, async () => {
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
    // placed`, or `must be holding an item`. Carried through, not flattened to false: it distinguishes a
    // server refusal from a wrong reference block (Law 13).
    return { ok: false, after, reason: `placeBlock refused: ${place.reason} | ${cellHolds(bot, pos)}` };
  }
  if (after && !isAir(after.name)) return { ok: true, after, reason: null };
  return { ok: false, after, reason: `place returned but the cell is still air — the block did not stick | ${cellHolds(bot, pos)}` };
}

// ── A BODY IN THE CELL IS HIT UNTIL IT IS OUT OF THE CELL ────────────────────────────────────────────
// The server places no block into a cell a creature's body overlaps, so an entity in the cell that is not
// a player is hit, the cell is read again, and it is hit for as long as it is still inside the cell. The
// place goes ahead the moment the cell reads empty. A dropped item, an experience orb and a projectile
// have no body the server refuses a block for.
const BODILESS = new Set(['item', 'experience_orb']);
const CHARGE_POLL_MS = 50;   // one tick between reads of the cell while the swing recharges
const HIT_LIMIT = 40;        // hits on one cell before the place is given back to its caller as refused
const REACH_WAIT_MS = 4000;  // how long a creature in the cell but out of the arm's reach is waited on to wander

// Does this entity's box overlap the unit cell at `pos`? The box is feet-centred on the entity's position.
function overlapsCell(e, pos) {
  if (!e || !e.position) return false;
  const half = (e.width || 0.6) / 2, tall = e.height || 1.8;
  return e.position.x + half > pos.x && e.position.x - half < pos.x + 1
    && e.position.z + half > pos.z && e.position.z - half < pos.z + 1
    && e.position.y + tall > pos.y && e.position.y < pos.y + 1;
}

function bodiesInCell(bot, pos) {
  return Object.values(bot.entities).filter((e) => {
    if (!e || e === bot.entity || e.type === 'player') return false;
    if (e.type === 'orb' || e.type === 'projectile' || BODILESS.has(e.name)) return false;
    return overlapsCell(e, pos);
  });
}

// What this body reads in the cell, for the reason of a place that did not happen: the block there, and
// every entity whose box overlaps it — this body, a peer by name, a creature, a dropped item — each with
// where it stands. Nothing is left out of it, so the reader sees what the body saw.
function cellHolds(bot, pos) {
  const block = bot.blockAt(pos);
  const at = (e) => `(${e.position.x.toFixed(2)},${e.position.y.toFixed(2)},${e.position.z.toFixed(2)})`;
  const who = (e) => e === bot.entity ? 'this body' : e.type === 'player' ? `player ${e.username || 'unnamed'}` : (e.name || e.type || 'entity');
  const inside = Object.values(bot.entities).filter(e => overlapsCell(e, pos)).map(e => `${who(e)}@${at(e)}`);
  return `in the cell: block=${block ? block.name : 'unseen'} entities=${inside.length ? inside.join(',') : 'none'}`;
}

// The cell is read on every pass, so between one swing and the next the body sees whether the last one
// moved the entity out. A swing is thrown only at full charge on combat's own swing clock, and it is a
// knockback swing — sprint armed in the same tick as the hit — because the hit is there to move the
// entity out of the cell.
async function clearCell(bot, pos, tag) {
  const combat = require('@utils/combat_utils');
  const { weaponProfile } = require('@utils/calculators/attack_cadence_calculator');
  let hits = 0, name = null, outOfReachSince = null;
  for (let target = bodiesInCell(bot, pos)[0]; target; target = bodiesInCell(bot, pos)[0]) {
    name = target.name || 'entity';
    if (hits >= HIT_LIMIT) return { ok: false, reason: `${name} is still in the cell after ${hits} hit(s) | ${cellHolds(bot, pos)}` };
    // A cell in placing reach can hold a creature past the arm's shorter reach. It is waited on to wander
    // out or come closer; a swing at it would be refused.
    const gap = combat.swingDistance(bot, target);
    if (gap != null && gap > combat.BOT_STRIKE_REACH) {
      outOfReachSince = outOfReachSince || Date.now();
      if (Date.now() - outOfReachSince > REACH_WAIT_MS) {
        return { ok: false, reason: `${name} stayed in the cell ${gap.toFixed(2)} blocks off, past the ${combat.BOT_STRIKE_REACH}-block arm, for ${REACH_WAIT_MS} ms | ${cellHolds(bot, pos)}` };
      }
      await sleep(CHARGE_POLL_MS);
      continue;
    }
    outOfReachSince = null;
    const cooldownMs = weaponProfile(bot.heldItem ? bot.heldItem.name : null).cooldownMs;
    if (combat.chargeNow(cooldownMs) < 1) { await sleep(CHARGE_POLL_MS); continue; }
    await guardExternal(tag, `look at ${name}`, () => bot.lookAt(target.position.offset(0, (target.height || 1.8) / 2, 0)));
    combat.armSprint(bot);
    const swung = combat.swingNow(bot, target, tag);
    combat.releaseSprint(bot);
    if (!swung) return { ok: false, reason: `the swing at ${name} in the cell was refused | ${cellHolds(bot, pos)}` };
    hits++;
    // Combat's own settle: the shove plays out before the cell is read for whether it worked.
    await sleep(combat.KNOCKBACK_SETTLE_MS);
  }
  if (hits) watcher.summary(tag, `CELL_CLEARED cell=(${pos.x},${pos.y},${pos.z}) entity=${name} hits=${hits}`);
  return { ok: true };
}

// ── THE FACING PLACE ────────────────────────────────────────────────────────────────────────────────
// For a block whose facing matters.
//   1. `bot.placeBlock` re-aims at the clicked face's centre before it sends, erasing any chosen look. The
//      click goes through `_placeBlockWithOptions` with forceLook 'ignore', so the library never turns the
//      head; the bot aims itself.
//   2. A forced look is not sent until the next physics tick, and the server copies the body's yaw to the
//      head yaw (what chests read) only when it ticks the player. AIM_SETTLE_TICKS covers both.
//   3. The yaw is computed from the direction vector with the same formula `bot.lookAt` uses, so there is
//      no direction table to get wrong.
// The reported yaw is snapped onto the rule's direction for the click, from wherever the body stands, and
// the click may land on a face the eye does not see (Law 19). Facing never costs a stand: an anchor that
// reaches a cell can set any facing in it.
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

  // Sneak is part of the state for a chest (it keeps one single beside another), and it is how a click lands
  // a block against an interactable one (a barrel, a trapdoor) instead of opening it. Released on every exit,
  // the same guarantee the face-centre place gives.
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
  if (!place.ok) return { ok: false, after, reason: `placeBlock refused: ${place.reason} [${ref}] | ${cellHolds(bot, pos)}`, state: { wanted, got: null, ok: false } };
  if (!after || isAir(after.name)) return { ok: false, after, reason: `place returned but the cell is still air — the block did not stick [${ref}] | ${cellHolds(bot, pos)}`, state: { wanted, got: null, ok: false } };

  // OPEN IS A USE, NOT A PLACEMENT. A trapdoor, door or gate always lands closed; one right-click opens it,
  // sent the same way the place was — the rotation snapped, then the click with no library re-aim —
  // because opening reads the look too: the look for the use is the block's own facing. Read back after
  // each click, at most USE_ATTEMPTS, and only while it still reads closed, so a click the server did not
  // act on is retried and an open block is never shut.
  if (aim.use) {
    const facing = after.getProperties().facing;
    const useYaw = facing ? Math.atan2(-({ east: 1, west: -1 }[facing] || 0), -({ south: 1, north: -1 }[facing] || 0)) : aim.yaw;
    for (let attempt = 1; attempt <= USE_ATTEMPTS && String(after.getProperties().open) !== 'true'; attempt++) {
      await waitNoSneak(bot);
      const used = await guardExternal(tag, `open ${blockName} at (${pos.x},${pos.y},${pos.z})`, async () => {
        // The click is sent with an item in the hand, and the block just placed may have been the last of
        // its stack: the hand is filled from the pocket before the use.
        if (!bot.heldItem) {
          const any = bot.inventory.items()[0];
          if (any) await bot.equip(any, 'hand');
        }
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
  // What stands for the asked state is the asked state (a door on the hinge side the game chose).
  return { got: read.got, ok: read.ok || facingAim.standsFor(block, wanted) };
}

// setSneak — the ONE way this route crouches. Sends sneak as `player_input.shift`, which a server
// reporting `entityActionUsesStringMapper` reads as the click's secondary-use bit on its own. A server
// without that feature instead reads secondary-use off the legacy `entity_action` press/release-shift
// command, sent alongside for exactly that case.
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
  clearCell,
  PLACE_SETTLE_MS,
};
