// module: movement/combat_movement — the geometry a fight needs, and NOT the fight itself. Every
// function is a pure question about the world; none of them move the body.
//
// Split from the walking layer because a counter asks these BEFORE it commits to anything, and mixing
// them with the primitives that press keys made it easy to write a counter that acted while it was
// still deciding. Keeping the questions in their own module is what keeps that ordering visible.

'use strict';

const { dist3 } = require('@utils/movement/terrain_predicates');

const CREEPER_ATTACK_REACH = 3.5;

// canLandStrike: REACH ONLY — the live 3D gap against the weapon's reach. Verdict only; the caller
// decides to swing.
//
// Line-of-sight is deliberately NOT a factor here. It qualifies whether a fight should START (aggro,
// stage 1 of the pipeline), not whether a strike within reach lands — a mob can be hit through a wall,
// so sightline is a fact about aggro, not about the swing. Gating the strike on it is actively wrong at
// close range: hasLineOfSight casts from the bot's floored cell corner toward the mob's feet-block
// centre, which at one block of separation is a short steep ray that clips a block boundary — exactly
// when the mob is close enough that a false "no line of sight" costs the most.
function canLandStrike(bot, mobPos, opts = {}) {
  const reach = opts.reach || CREEPER_ATTACK_REACH;
  return dist3(bot.entity.position, mobPos) <= reach;
}

module.exports = {
  CREEPER_ATTACK_REACH,
  canLandStrike,
};
