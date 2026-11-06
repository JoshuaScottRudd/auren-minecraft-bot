'use strict';
// One prototype outing seeks an observed ink gain. The swimming owner can revoke it at any tick;
// a missing squid is never reported as a kill or as ink collected (Law 25).
const swimming = require('@locomotion/underwater_swimming');
const combat = require('@utils/combat_utils');
const { sleep } = require('@utils/fragment_utils');
const watcher = require('@kernel/watcher');
const { hasEntityLineOfSight } = require('@utils/movement/terrain_predicates');
const { guardExternalSync } = require('@utils/external_library_guard');
const TAG = 'ink_diver';

function inkCount(bot) { return bot.inventory.items().filter(i => i.name === 'ink_sac').reduce((n,i) => n+i.count,0); }
function nearest(bot, predicate) {
  return Object.values(bot.entities).filter(e => e.position && predicate(e))
    .sort((a,b) => a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))[0];
}
function inkDrop(e) {
  if (e.name !== 'item') return false;
  const read = guardExternalSync(TAG,'mineflayer dropped item',() => e.getDroppedItem?.());
  return read.ok && read.value?.name === 'ink_sac';
}

async function collectInk(bot, options = {}) {
  const before = inkCount(bot);
  const result = await swimming.withDive(bot, options, async lease => {
    const choice = await combat.equipBestWeapon(bot);
    let swings = 0, emptySince = null;
    while (swimming.ownsDive(bot,lease) && bot.health > 0) {
      const gained = inkCount(bot)-before;
      if (gained > 0) return { ok: true, reason: 'ink_collected', gained, swings };
      // Drops already present take precedence; a disappearing target contributes no result of its own.
      const drop = nearest(bot,inkDrop);
      const squid = nearest(bot,e => e.name === 'squid');
      const target = drop || squid;
      if (!target) {
        // The death and item-spawn packets can arrive in separate ticks; only inventory proves pickup.
        if (swings && (emptySince === null || Date.now()-emptySince < 1000)) {
          if (emptySince === null) emptySince = Date.now();
          await sleep(50); continue;
        }
        return { ok: false, reason: 'no_loaded_squid_or_ink_drop', gained, swings };
      }
      emptySince = null;
      const moved = swimming.moveToward(bot,lease,target.position);
      if (!moved.ok) return { ...moved, gained, swings };
      if (!drop && combat.swingDistance(bot,squid) <= combat.BOT_STRIKE_REACH
          && hasEntityLineOfSight(bot,squid,combat.BOT_STRIKE_REACH)
          && combat.chargeNow(choice.profile.cooldownMs) >= 1 && swimming.ownsDive(bot,lease)) {
        if (combat.swingNow(bot,squid,TAG)) swings++;
      }
      await sleep(50);
    }
    return { ok: false, reason: swimming.status(bot).reason || 'dive_revoked', gained: inkCount(bot)-before, swings };
  });
  const gained = inkCount(bot)-before;
  watcher.summary(TAG, `INK_OUTING ok=${result.ok} reason=${result.reason} gained=${gained} surfaced=${result.surfaced ?? false}`);
  return { ...result, gained };
}
module.exports = { collectInk };
