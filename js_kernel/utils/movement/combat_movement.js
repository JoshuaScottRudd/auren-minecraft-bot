// Pure geometry questions for combat — none of them move the body. Kept apart from the
// walking primitives so a counter can ask these before it commits to acting.

'use strict';

const { dist3 } = require('@utils/movement/terrain_predicates');

const CREEPER_ATTACK_REACH = 3.5;

// Reach only — the live 3D gap against the weapon's reach. Verdict only; the caller decides to
// swing. Line-of-sight gates whether a fight starts, not whether a strike in range lands.
function canLandStrike(bot, mobPos, opts = {}) {
  const reach = opts.reach || CREEPER_ATTACK_REACH;
  return dist3(bot.entity.position, mobPos) <= reach;
}

module.exports = {
  CREEPER_ATTACK_REACH,
  canLandStrike,
};
