// module: survival_instincts
// purpose: Tick-level autonomous reflexes that keep the bot alive regardless of what task
//          is running. These operate below the signal bus — no payloads, no fragments, no
//          routing. Raw physicsTick handlers that act directly on control state.
//
//          Lives in custom_api/locomotion because survival reflexes produce movement (swimming
//          upward, etc.) and the folder is designed to be self-contained and exportable.
//
// contract:
//  - start(bot) attaches all survival reflexes to the bot's physicsTick event.
//  - stop() detaches them. Logs a Law 17 warning — the caller is accepting drowning risk.
//  - Each reflex is independently toggleable via enable/disable functions.
//  - No watcher, no signal_bus, no file I/O — pure tick-level reactions.
//  - Atomic: depends on nothing except the bot instance. No imports from other project modules.

const Vec3 = require('vec3');
const { guardExternalSync } = require('@utils/external_library_guard');

// ---------------------------------------------------------------------------
// SECTION 1: State
// ---------------------------------------------------------------------------
let attached = false;
let tickHandler = null;

// Per-reflex enable flags. All default to ON — survival is opt-out, not opt-in.
const reflexes = {
  antiDrown: true,
  doorHandler: true,
  // autoTorch REMOVED: the walk-and-place torch reflex had no block-awareness — no sense of existing
  // torches or build footprints — so the surface piled up with incoherent torches and rogue ones landed
  // on blueprint voxels. Removed wholesale pending a redesign. The 'autoTorch' key is gone, so
  // battle_stations/torch_executor's enable/disableReflex('autoTorch') calls become harmless no-ops
  // (both guard with `if (!(name in reflexes)) return`).
  //
  // shieldGuard and shieldFacing REMOVED. Both keys are gone, so every surviving
  // enable/disableReflex('shieldGuard') call is a harmless no-op by the same `name in reflexes` guard
  // that absorbs 'autoTorch' above — but the three DIRECT entry points (standDownShield, isShieldUp,
  // guardTarget) were deleted from the exports rather than stubbed, and their callers cut with them. A
  // stub that silently answers "no shield" is the redundant pathway Law 16 forbids: it would let a
  // caller keep asking a question this module no longer has any business answering, and read green
  // forever.
  //
  // What a successor re-adding it must know, because it is the reason the removal was clean rather than
  // commented-out: shieldFacing was the only CONTINUOUS yaw writer in this module, and the combat split
  // gives that number to `custom_api/gunner.js`. Re-introducing a tick-rate reflex that aims a shield
  // puts a second continuous writer back on the yaw, so it comes back through the gunner or not at all.
  //
  // THIS MODULE STILL WRITES THE YAW — twice, in doorHandlerTick (bot.lookAt to face a door before
  // activating it). The two writers are not equivalent and the difference is the whole reason one was
  // removed and one was kept: shieldFacing wrote EVERY tick of a fight, unconditionally; the door reflex
  // writes only when `forward` is held and a door sits within 1.5 blocks, which cannot happen during an
  // open-ground engagement and is momentary when it does.
  //
  // It is a real contender for the yaw in a DOORWAY fight, and nothing arbitrates that today. Do not
  // "fix" it by making the door reflex ask the gunner for permission — that is a second decision-maker
  // wearing a check (Law 16). It is an arbitration question, and arbitration is the commander's seat.
};

// ---------------------------------------------------------------------------
// SECTION 2: Reflex implementations
// ---------------------------------------------------------------------------

// antiDrown: if the bot is in water, hold jump to swim toward the surface.
// Releases jump the tick the bot leaves water, but only if this reflex was the one holding
// it — otherwise it would fight with navigator's climb_up steps that also use jump.
let antiDrownHolding = false;
function antiDrownTick(bot) {
  if (!reflexes.antiDrown) return;
  const inWater = bot.entity?.isInWater;
  if (inWater) {
    bot.setControlState('jump', true);
    antiDrownHolding = true;
  } else if (antiDrownHolding) {
    bot.setControlState('jump', false);
    antiDrownHolding = false;
  }
}

// doorHandler: open closed wooden doors when the bot is within reach, close them after
// passing through. Same philosophy as antiDrown — dumb tick-level reflex that makes doors
// transparent to whatever movement system is running. Handles village doors, player-placed
// doors, any wooden door. Iron doors excluded (require redstone, can't open by hand).
//
// Open phase: cardinal neighbor scan. Closed door within 1.5 blocks → activate to open,
//   start tracking its position.
// Close phase: tracked door + bot >2 blocks away → activate to close, clear tracking.
// Already-open doors: tracked for close-behind but never toggled on approach (prevents
//   accidentally closing a door in front of the bot).
const DOOR_BLOCKS = new Set([
  'oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
  'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door',
]);

let doorCooldown = false;
let trackedDoor = null;

// false on refusal means "treat it as shut", which is the safe direction: the handler then opens a door
// it may not need to rather than walking at one it wrongly believed open (Law 17 — no predictable
// self-obstruction), and never records the refusal as a measured door state.
function isDoorOpen(block) {
  const props = guardExternalSync('survival_instincts', 'read door properties', () => block.getProperties?.());
  return props.ok && !!props.value && String(props.value.open) === 'true';
}

function doorHandlerTick(bot) {
  if (!reflexes.doorHandler) return;
  if (doorCooldown) return;
  const pos = bot.entity?.position;
  if (!pos) return;
  const feet = pos.floored();

  if (trackedDoor) {
    const d = Math.hypot(pos.x - trackedDoor.x - 0.5, pos.z - trackedDoor.z - 0.5);
    if (d > 2.0) {
      const block = bot.blockAt(trackedDoor);
      if (block && DOOR_BLOCKS.has(block.name) && isDoorOpen(block)) {
        doorCooldown = true;
        const closeTarget = trackedDoor;
        trackedDoor = null;
        bot.lookAt(new Vec3(closeTarget.x + 0.5, closeTarget.y + 0.5, closeTarget.z + 0.5), true)
          .then(() => bot.activateBlock(block))
          .catch(() => {})
          .finally(() => { doorCooldown = false; });
      } else {
        trackedDoor = null;
      }
      return;
    }
  }

  if (!bot.controlState?.forward) return;

  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const doorPos = new Vec3(feet.x + dx, feet.y, feet.z + dz);
    const block = bot.blockAt(doorPos);
    if (!block || !DOOR_BLOCKS.has(block.name)) continue;
    const d = Math.hypot(pos.x - doorPos.x - 0.5, pos.z - doorPos.z - 0.5);

    if (!isDoorOpen(block)) {
      if (d < 1.5) {
        doorCooldown = true;
        trackedDoor = doorPos;
        bot.lookAt(new Vec3(doorPos.x + 0.5, doorPos.y + 0.5, doorPos.z + 0.5), true)
          .then(() => bot.activateBlock(block))
          .catch(() => {})
          .finally(() => { doorCooldown = false; });
        return;
      }
    } else {
      if (d < 1.0 && !trackedDoor) {
        trackedDoor = doorPos;
      }
    }
  }
}

// ── WHAT USED TO BE HERE, AND THE ONE THING WORTH CARRYING FORWARD ───────────────────────────────────
// A ~190-line shield stack lived between the door handler and the tick dispatcher: `shieldGuardTick`
// (raise-on-edge with the Law 19 sprint exclusion), `standDownShield`, `isShieldUp`, and
// `shieldFacingTick` (aim the shield at a named target, at tick rate, outside a 50° tolerance). All of
// it is deleted, not disabled, pending a redesign.
//
// It is recorded here rather than left in git alone because ONE of its findings will otherwise be
// rediscovered the expensive way: a vanilla client cannot sprint and block at the same time (starting an
// item-use clears the sprint flag), but mineflayer asserts sprint through its own entity-action packet,
// which the server honours independently — so a bot that just calls activateItem gets to sprint AND
// block. That is the Rogue Machine error by name (Law 19) — a protocol-level faculty claiming an
// operational right every other agent pays for — and whatever re-adds the shield owes that exclusion
// again, held every tick rather than applied once on the raise, because the mover re-asserts sprint at
// the start of every leg.

// ---------------------------------------------------------------------------
// SECTION 3: Tick dispatcher
// ---------------------------------------------------------------------------

// NOTHING IN THIS DISPATCHER WRITES THE YAW, and that is now a property the combat split depends on
// rather than a coincidence. `shieldFacingTick` used to sit below the door handler and re-aim the body
// at tick rate; with it gone the only writer of the facing anywhere in the fleet is the gunner. A
// successor adding a reflex here must not take the yaw (Invariant D) — a tick-rate writer beneath the
// combat loop is invisible to it and outruns every check it could make.
function onPhysicsTick(bot) {
  antiDrownTick(bot);
  doorHandlerTick(bot);
}

// ---------------------------------------------------------------------------
// SECTION 4: Public API
// ---------------------------------------------------------------------------

function start(bot) {
  if (attached) return;
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  attached = true;
  console.log('[survival_instincts] Started — anti-drown, door-handler active.');
}

function stop() {
  if (!attached || !tickHandler) return;
  console.log('[survival_instincts] WARNING: Stopping survival reflexes. The bot can now drown (Law 17 risk accepted by caller).');
  global.bot?.removeListener('physicsTick', tickHandler);
  tickHandler = null;
  attached = false;
}

// Silent by design: a toggle fires on every combat engage/disengage, so a log line here floods the
// console with no diagnostic value. The state flip is the whole job; the caller already logs the
// engagement it's suppressing a reflex for. Toggling a name not in `reflexes` (e.g. the removed
// 'autoTorch') is a deliberate no-op so old callers don't break.
function disableReflex(name) {
  if (!(name in reflexes)) return;
  reflexes[name] = false;
}

function enableReflex(name) {
  if (!(name in reflexes)) return;
  reflexes[name] = true;
}

module.exports = { start, stop, disableReflex, enableReflex };
