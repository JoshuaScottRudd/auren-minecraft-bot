// damage_types — the server's own names for the damage a blow carries. A `damage_event` packet names its damage
// type by an index into the `minecraft:damage_type` registry the server sends at login; that list is read here,
// in the order the server sent it (Law 23), so a blow reads as "arrow" or "mob_attack" and not as a bare 37.
// mineflayer hands the registry to prismarine-registry, which keeps no damage types.
//
// Armed immediately after createBot (master_core): registry_data arrives in the configuration phase, before
// `spawn`, so a listener added at spawn never sees it. Per bot, so the headless bench's bodies never share one.

'use strict';

const _names = new WeakMap();

// arm(bot) — latches the damage type list off the server's registry_data packet. Idempotent.
function arm(bot) {
  if (!bot || !bot._client) {
    throw new Error('[damage_types] CODING VIOLATION: arm called with no client to listen on.');
  }
  if (_names.has(bot)) return;
  _names.set(bot, null);
  bot._client.on('registry_data', (packet) => {
    if (!packet || packet.id !== 'minecraft:damage_type' || !Array.isArray(packet.entries)) return;
    _names.set(bot, packet.entries.map((e) => String(e.key).replace('minecraft:', '')));
  });
}

// nameOf(bot, id) → the damage type's name, or null when the list never arrived or the index is outside it.
function nameOf(bot, id) {
  const names = bot ? _names.get(bot) : null;
  return names && Number.isInteger(id) && id >= 0 && id < names.length ? names[id] : null;
}

module.exports = { arm, nameOf };
