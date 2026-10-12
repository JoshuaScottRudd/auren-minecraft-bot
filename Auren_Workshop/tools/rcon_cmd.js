// rcon_cmd.js — the operator's one-shot RCON console: sends server-console ops an offline (non-op) bot
// cannot self-issue (parking a client, forcing spectator, /spectate-ing one player onto another,
// summoning a mob for the arena).
//
// The Source-RCON protocol lives in `rcon_link`, shared with camera_rig and the arena director (Law 16).
// This file is the CLI: parse argv, print each reply.
//
// Usage: node rcon_cmd.js "gamemode spectator Gimbal_Cam" "spectate Gimbal_Cam Cam_AurenBot" ...
// Exit codes: 0 ok · 1 link/auth failure.
'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/rcon_cmd.js');

const rconLink = require(require('../workshop_paths').bot('js_kernel/utils/rcon_link'));

const cmds = process.argv.slice(2);

rconLink.once(cmds)
  .then(results => {
    for (const { cmd, body } of results) console.log(`> ${cmd}\n${body || '(ok)'}`);
    process.exit(0);
  })
  .catch(e => { console.error('RCON error:', e.message); process.exit(1); });
