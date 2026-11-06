// mounted_riders — a mob riding a mount is where its mount is.
//
// The server sends no position for a passenger: a client places a rider on its vehicle every tick. mineflayer records
// the link (`entity.vehicle`, `vehicle.passengers`) but never moves the rider, so a zombie horseman reads where it was
// spawned while its horse carries it to the body: a probe read the rider fixed at 15.0 b while its horse closed to
// 3.9 b, and a spear zombie read at 24.5 b struck a working body five times and was never fought.
//
// One listener on the body moves every passenger with its vehicle whenever the vehicle moves, so every reader (the
// commander, the gunner, the driver, the gaze guard) sees the rider where it is, with no reader changed.

'use strict';

// A rider sits this share of its mount's height above the mount's feet (a horse 1.6 b high seats its rider at 1.2 b).
const SEAT_SHARE = 0.75;
// Riders riding riders are followed this deep.
const MAX_STACK = 4;

// seat(vehicle, depth, self) — every passenger of this vehicle placed on it; `self` (the body, which mineflayer moves
// itself) is never touched.
function seat(vehicle, depth, self) {
  if (!vehicle || !vehicle.position || !Array.isArray(vehicle.passengers) || depth > MAX_STACK) return;
  const up = (typeof vehicle.height === 'number' ? vehicle.height : 1) * SEAT_SHARE;
  for (const rider of vehicle.passengers) {
    if (!rider || !rider.position || rider === vehicle || rider === self) continue;
    rider.position.x = vehicle.position.x;
    rider.position.y = vehicle.position.y + up;
    rider.position.z = vehicle.position.z;
    seat(rider, depth + 1, self);
  }
}

// followMounts(bot) — installs the listener once, beside the world-read masks.
function followMounts(bot) {
  if (!bot || typeof bot.on !== 'function') {
    throw new Error('[mounted_riders] CODING VIOLATION: followMounts called with no body to follow for.');
  }
  if (bot._mountedRidersFollowed) return;
  bot._mountedRidersFollowed = true;
  bot.on('entityMoved', (entity) => {
    if (entity && Array.isArray(entity.passengers) && entity.passengers.length) seat(entity, 0, bot.entity);
  });
}

module.exports = { followMounts };
