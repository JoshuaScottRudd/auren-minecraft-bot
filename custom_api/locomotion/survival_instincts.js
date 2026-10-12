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
//  - No signal_bus, no file I/O — pure tick-level reactions. The watcher is its one output: the fall
//    alert's warning line.

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
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
  // 'autoTorch', 'shieldGuard' and 'shieldFacing' are not keys here: enable/disableReflex calls
  // naming them are harmless no-ops via the `name in reflexes` guard below, so old callers do not
  // break.
  //
  // This module writes the yaw only in doorHandlerTick, to face a door before activating it; the
  // only other continuous yaw writer in the fleet is the gunner (custom_api/gunner.js). The door
  // write is conditional (forward held, door within 1.5 blocks) and momentary, so a doorway fight
  // is the one case where both could want the yaw at once, and nothing arbitrates that today —
  // arbitration belongs to the commander's seat, not a check added here.
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

// False on refusal means "treat it as shut", the safe direction (Law 17 — no predictable
// self-obstruction): the handler may open a door it did not need to, but never records the
// refusal as a measured door state.
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


// fallAlert: a body never falls in normal work — navigation plans no drop past one block (dig_down
// is the deepest), so landing 2+ blocks below the take-off point means something threw it (a
// blast, a hit, a floor that was not there). It warns and changes nothing: the work carries on.
// Measured take-off to landing, so a jump's arc is not counted; water and climbing reset it.
// The alert also carries what the body was doing as it left the ground, so the fall can be told
// apart: the floor under a still body removed (no controls, centre was over a block) or a body
// that walked off an edge (forward held, centre already over air on its last standing tick).
const FALL_ALERT_BLOCKS = 1.5;
let takeoff = null;
let lastStand = null;
function heldControls(bot) {
  const held = ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak'].filter(c => bot.controlState?.[c]);
  return held.length ? held.join('+') : 'none';
}
// The navigator's step in hand as the body left the ground (navigator stamps bot._navStep per step).
function navStepText(bot) {
  const s = bot._navStep;
  if (!s) return 'no navigator step yet';
  const c = (v) => (v ? `${v.x},${v.y},${v.z}` : '?');
  return `navigator ${s.edge}${s.run >= 2 ? ` (run of ${s.run})` : ''} (${c(s.from)})→(${c(s.to)}) toward (${c(s.goal)})${s.exact ? ' exact' : ''}, stamped ${Date.now() - s.at}ms ago`;
}
function fallAlertTick(bot) {
  const e = bot.entity;
  if (!e || !e.position) return;
  if (e.isInWater || e.isInLava || e.isOnLadder) { takeoff = null; return; }
  if (!e.onGround) {
    if (!takeoff) {
      const hs = Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0);
      takeoff = { pos: e.position.clone(), controls: heldControls(bot), hspeed: hs, stand: lastStand, nav: navStepText(bot) };
    }
    return;
  }
  const under = bot.blockAt(e.position.floored().offset(0, -1, 0));
  lastStand = under ? under.name : 'unloaded';
  if (!takeoff) return;
  const drop = takeoff.pos.y - e.position.y;
  if (drop >= FALL_ALERT_BLOCKS) {
    const f = (v) => `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`;
    watcher.warn('survival_instincts', `FALL ALERT: fell ${drop.toFixed(1)} blocks, (${f(takeoff.pos)}) → (${f(e.position)}) `
      + `| controls ${takeoff.controls}, speed ${takeoff.hspeed.toFixed(2)}, under the centre on the last standing tick: ${takeoff.stand ?? 'unknown'} | ${takeoff.nav}.`);
  }
  takeoff = null;
}

// ---------------------------------------------------------------------------
// SECTION 3: Tick dispatcher
// ---------------------------------------------------------------------------

// Nothing in this dispatcher writes the yaw: the only writer of the facing anywhere in the fleet
// is the gunner. A successor adding a reflex here must not take the yaw (Invariant D) — a
// tick-rate writer beneath the combat loop is invisible to it and outruns every check it could
// make.
function onPhysicsTick(bot) {
  antiDrownTick(bot);
  doorHandlerTick(bot);
  fallAlertTick(bot);
}

// ---------------------------------------------------------------------------
// SECTION 4: Public API
// ---------------------------------------------------------------------------

function start(bot) {
  if (attached) return;
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  attached = true;
  console.log('[survival_instincts] Started — anti-drown, door-handler, fall-alert active.');
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
// engagement it's suppressing a reflex for. Toggling a name not in `reflexes` is a deliberate
// no-op so old callers don't break.
function disableReflex(name) {
  if (!(name in reflexes)) return;
  reflexes[name] = false;
}

function enableReflex(name) {
  if (!(name in reflexes)) return;
  reflexes[name] = true;
}

module.exports = { start, stop, disableReflex, enableReflex };
