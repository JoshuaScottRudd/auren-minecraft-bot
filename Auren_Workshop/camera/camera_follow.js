// camera_follow.js (simplified)
// Only responsibility: switch a fixed viewer account into spectator on start, and back to creative on stop.
// No offsets, no teleport loops, no spectate attach logic.

let state = { active: false, viewer: 'KaptainKrispyjr' };

function start(bot, options = {}) {
  if (!bot) throw new Error('camera_follow.start before bot');
  state.viewer = options.viewer || 'KaptainKrispyjr';
  bot.chat(`/gamemode spectator ${state.viewer}`);
  state.active = true;
  console.log(`🎥 follow: set ${state.viewer} to spectator.`);
}

function stop() {
  if (!state.active) return;
  try { global.bot?.chat(`/gamemode creative ${state.viewer}`); } catch(_) {}
  console.log(`🎥 unfollow: set ${state.viewer} to creative.`);
  state.active = false;
}

module.exports = { start, stop, _state: state };
