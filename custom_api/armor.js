// module: armor
// purpose: recognizes the armor the fleet counts (architect_config.ARMOR: iron or better) and puts it on. A piece below
//          the minimum is not armor to this module, so it is never worn over nothing and never counted in a set.

'use strict';

const watcher = require('@kernel/watcher');
const { guardExternal } = require('@utils/external_library_guard');
const { ARMOR } = require('@thinking/architect_config');

const TAG = 'armor';
// Each kind of piece and the equipment slot mineflayer names for it.
const SLOT_OF = Object.freeze({ helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' });
const KINDS = Object.freeze(Object.keys(SLOT_OF));

// armorPiece(name) → { name, tier, kind, slot, rank } for a piece the fleet counts, higher rank better; else null.
function armorPiece(name) {
  const at = String(name).lastIndexOf('_');
  const tier = String(name).slice(0, at);
  const kind = String(name).slice(at + 1);
  const rank = ARMOR.tiers.indexOf(tier);
  if (at < 0 || rank < 0 || !SLOT_OF[kind]) return null;
  return { name, tier, kind, slot: SLOT_OF[kind], rank };
}

// fullSets(counts) → how many whole sets { item: count } holds, tiers mixed: the count of its scarcest kind.
function fullSets(counts) {
  const have = Object.fromEntries(KINDS.map(kind => [kind, 0]));
  for (const [name, count] of Object.entries(counts || {})) {
    const piece = armorPiece(name);
    if (piece) have[piece.kind] += count;
  }
  return Math.min(...Object.values(have));
}

// worn(bot, slot) → the item in an equipment slot, or null.
function worn(bot, slot) {
  return bot.inventory.slots[bot.getEquipmentDestSlot(slot)] || null;
}

// wearArmor(bot) → how many pieces went on. The pocket's best piece of each kind goes on when it beats what the slot
// holds; what it replaces falls back to the pocket and the next drop-off banks it. Each slot is read back after the
// equip, so a refused one is reported rather than counted.
async function wearArmor(bot) {
  let put = 0;
  for (const kind of KINDS) {
    const slot = SLOT_OF[kind];
    const best = bot.inventory.items()
      .filter(item => armorPiece(item.name)?.kind === kind)
      .sort((a, b) => armorPiece(b.name).rank - armorPiece(a.name).rank)[0];
    if (!best) continue;
    const current = worn(bot, slot);
    const currentPiece = current ? armorPiece(current.name) : null;
    if (currentPiece && currentPiece.rank >= armorPiece(best.name).rank) continue;
    const name = best.name;
    await guardExternal(TAG, `put on ${name}`, () => bot.equip(best, slot));
    if (worn(bot, slot)?.name === name) {
      put++;
      watcher.summary(TAG, `WORE ${name} slot=${slot}${current ? ` replaced=${current.name}` : ''}`);
    } else {
      watcher.warn(TAG, `${name} did not reach ${slot}: the slot holds ${worn(bot, slot)?.name || 'nothing'}`);
    }
  }
  return put;
}

module.exports = { armorPiece, fullSets, worn, wearArmor };
