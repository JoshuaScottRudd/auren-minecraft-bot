// enderman_gaze — the body never meets a calm enderman's eyes.
//
// An enderman turns on the player whose view ray lands on its eyes: the server's test is the dot of the player's
// view with the line to the enderman's eyes above 1 - 0.025 / distance. Every head turn the body makes, a walk's, a
// dig's, a fight's, goes through `bot.look` (mineflayer's `lookAt` calls it), so one wrapper there covers every caller
// with no caller changed, as spawn_protection's mask covers every read. A look that would meet a calm enderman's eyes
// is tipped down past them; the yaw is kept. An angry enderman (combat_utils.endermanAngry) is a fight, and the gunner
// faces it as it faces any focus.

'use strict';

const crewLog = require('@api/crew_log');
const { endermanAngry } = require('@utils/combat_utils');

const TAG = 'ENDERMAN_GAZE';
const PLAYER_EYE = 1.62;
const ENDERMAN_EYE = 2.55;
// The reach of the enderman's stare check; past this no look provokes one.
const STARE_REACH_B = 64;
// Radians kept below the stare cone, for the head's own settle and an enderman that moves within the tick.
const MARGIN_RAD = 0.12;
// One trace line per enderman per this long.
const SAY_EVERY_MS = 5000;

const said = new Map();

function viewOf(yaw, pitch) {
  return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
}

// stareAt(bot, yaw, pitch) → { entity, eyesPitch, cone } for the first calm enderman whose eyes this look meets, or null.
function stareAt(bot, yaw, pitch) {
  const me = bot.entity && bot.entity.position;
  if (!me) return null;
  const v = viewOf(yaw, pitch);
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e.name !== 'enderman' || !e.position || endermanAngry(bot, e)) continue;
    const dx = e.position.x - me.x, dy = e.position.y + ENDERMAN_EYE - (me.y + PLAYER_EYE), dz = e.position.z - me.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > STARE_REACH_B || d < 0.5) continue;
    const cone = Math.acos(Math.max(-1, 1 - 0.025 / d));
    const angle = Math.acos(Math.max(-1, Math.min(1, (v.x * dx + v.y * dy + v.z * dz) / d)));
    if (angle <= cone + MARGIN_RAD) return { entity: e, eyesPitch: Math.atan2(dy, Math.hypot(dx, dz)), cone, d };
  }
  return null;
}

// guardGaze(bot) — wraps the body's `look`. Called once, beside the world-read mask; idempotent.
function guardGaze(bot) {
  if (!bot || typeof bot.look !== 'function') {
    throw new Error('[enderman_gaze] CODING VIOLATION: guardGaze called with no body to guard.');
  }
  if (bot._endermanGazeGuarded) return;
  bot._endermanGazeGuarded = true;
  const realLook = bot.look.bind(bot);
  bot.look = (yaw, pitch, force) => {
    let p = pitch;
    // Up to three calm endermen in one line of sight are stepped past, nearest first met.
    for (let i = 0; i < 3; i++) {
      const hit = stareAt(bot, yaw, p);
      if (!hit) break;
      const next = Math.max(-Math.PI / 2, hit.eyesPitch - hit.cone - 2 * MARGIN_RAD);
      if (next >= p) break;
      const now = Date.now();
      if (now - (said.get(hit.entity.id) || 0) >= SAY_EVERY_MS) {
        said.set(hit.entity.id, now);
        crewLog.post(TAG, 'gaze', { subject: `enderman#${hit.entity.id}`, state: 'averted', d: hit.d.toFixed(1),
          from: pitch.toFixed(2), to: next.toFixed(2) });
      }
      p = next;
    }
    for (const id of said.keys()) if (!(bot.entities && bot.entities[id])) said.delete(id);
    return realLook(yaw, p, force);
  };
}

module.exports = { guardGaze, stareAt };
