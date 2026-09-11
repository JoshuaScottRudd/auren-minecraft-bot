// rcon_cmd.js — the operator's one-shot RCON console.
//
// WHY IT EXISTS: parking a client, forcing spectator, /spectate-ing one player onto another, summoning
// a mob for the arena — these are server-CONSOLE ops; an offline (non-op) bot cannot self-issue them.
// This is the hand-typed route to them.
//
// It carried its OWN copy of the Source-RCON protocol; the framing, the auth handshake and the
// server.properties read now live in `rcon_link` and are shared with camera_rig and the arena
// director (Law 16 — one capability, one implementation). What is left here is the CLI: parse argv,
// print each reply. Deleting this file would cost the operator a console and nothing else.
//
// Usage: node rcon_cmd.js "gamemode spectator Gimbal_Cam" "spectate Gimbal_Cam Cam_AurenBot" ...
// Exit codes: 0 ok · 1 link/auth failure.
'use strict';

const rconLink = require(require('../workshop_paths').bot('js_kernel/utils/rcon_link'));

const cmds = process.argv.slice(2);

rconLink.once(cmds)
  .then(results => {
    for (const { cmd, body } of results) console.log(`> ${cmd}\n${body || '(ok)'}`);
    process.exit(0);
  })
  .catch(e => { console.error('RCON error:', e.message); process.exit(1); });
