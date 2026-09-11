// camera_gimbal — the aim half of the film crew. One headless mineflayer client per camera whose HEAD is
// pointed at the bot every tick; the Prism camera client /spectate's it and therefore renders that head
// orientation. The rig keeps WHERE to stand and WHEN to cut; this file owns only WHERE THE LENS POINTS.
//
// WHY IT EXISTS. A locked tripod freezes its aim at the cut, so a traversing bot leaves the frame and sits
// half-off — or fully off — until the exit test fires. That is the defect the Architect judged in three of
// twelve frames on 2026-07-21. Reading the destination out of the trace never fixed it, and could not:
// knowing where the bot is GOING says nothing about how to hold it EN ROUTE. Continuous aim replaces the
// forecast with a per-tick fact.
//
// WHY IT HAS TO BE AN ENTITY, not the camera itself. Minecraft clients INTERPOLATE the rotation of entities
// they watch, and never interpolate the local player's. So a camera rotated by `tp … <yaw> <pitch>` steps at
// 20 Hz (the first pan attempt, rejected as judder), while a camera SPECTATING a rotating entity is smoothed
// to render framerate for free. Verified by measurement 2026-07-20, not assumed: 81% of recorded frames
// carried motion where raw 20 Hz would have given ~33%. This whole design is downstream of that one fact.
//
// WHY IT EASES INSTEAD OF SNAPPING (the taste, and it is load-bearing). Pointing exactly at the bot every
// tick would centre it perfectly — and read as a turret. Dead-centre lock destroys lead room, makes the world
// slide past a pinned subject, and transmits the bot's own micro-jitter, which is precisely the motion that
// got the first pan rejected. So: a DEAD ZONE the bot may drift inside with the camera perfectly still, then
// an exponential ease that lags slightly on a sudden move and settles without overshoot. `easePerTick: 1`
// with `deadzoneDeg: 0` reproduces the turret exactly — that combination is the debug setting, not a look.
//
// ── AND IT WATCHES ITS OWN SIGHTLINE (the second job, added deliberately) ──────────────────────────
// This client is PARKED AT THE LENS. That is an accident of how the aim works, and it makes it the only
// client in the crew whose loaded chunks are guaranteed to be the ones the picture is made of — the scout
// is parked somewhere else entirely and can be at the edge of its view distance from a camera it is
// grading. So twice a second it walks the line from its own eye to the subject and reports whether the
// shot still has a subject in it.
//
// IT REPORTS; IT DOES NOT CUT. The rig owns when a camera moves, and it owns it because the answer depends
// on things this file cannot see — whether the shot is a travel leg mid-journey (where a hidden bot is the
// NORMAL state and cutting would destroy the one unbroken shot of the walk), whether it is a see-through
// tripod underground (where a spectator renders through rock and "blocked" is meaningless), how long the
// shot has held. A gimbal that cut on its own would be a second decider of the same question (Law 16), and
// the one with the least context. So it exposes a reading and the rig decides.
//
// WHY IT IS A LINE AND NOT THE CONE. The cone grades the FRAME — how much of the picture is canopy-free —
// and it costs 117 rays, which is why the rig only affords it every 5s. This asks the cruder and more
// urgent question: is the bot VISIBLE AT ALL. That is ~20 block lookups, cheap enough to ask at 2 Hz, and
// it is the one that matters at speed: there is no value in recording leaves, so a shot whose subject has
// gone behind a trunk should end now rather than at the next timer. The two are kept side by side because
// they fail differently — a shot can hold a perfectly visible bot in a frame that is otherwise all foliage.
//
// The walk itself is ./sightline, shared with the scout, because a rig that CUTS on one definition of
// "blocked" while the seeker PLACES on another is a rig that argues with itself (Law 16).
//
// Module resolution + graceful degradation mirror camera_scout: mineflayer lives in the sibling
// node_env2/node_modules, and if the require or the connection fails this returns { available:false } so the
// rig falls back to the old frozen-aim tripod. Filming must survive a missing gimbal.

'use strict';

const path = require('path');
const fs = require('fs');
const { walkLine } = require('./sightline');

// A PRIVATE COPY OF THIS STOOD HERE AND KNEW ABOUT ONE MACHINE. It named `node_env2` alone, so this
// file worked at home and could not resolve mineflayer on the portable-node workstation — the fifth
// hand-written answer to "where do the modules live", and exactly the drift
// `js_kernel/utils/node_module_homes` was written to end (its own header records the other four).
// Returns whether any home was found, which is the boolean the caller below tests.
function bootstrapModulePath() {
  return require('../workshop_paths').bootstrapModules().length > 0;
}

const RAD = Math.PI / 180;
const TICK_MS = 50;
const shortestDeg = a => ((a + 180) % 360 + 360) % 360 - 180;

// createGimbals({ bots, host, port, version, cfg, log }) → { available, get(bot), endAll() }
// One gimbal per bot; each is named cfg.prefix + botName.
function createGimbals({ bots, host, port, version, cfg, log, visualBlockers }) {
  let mineflayer, Vec3 = null;
  try {
    bootstrapModulePath();
    mineflayer = require('mineflayer');
  } catch (e) {
    return { available: false, reason: e.message, get: () => null, endAll: () => {},
             occlusion: () => ({ known: false }) };
  }
  // vec3 is only needed to ADDRESS a cell for the sightline walk, so it is required separately and its
  // absence costs the watch and nothing else. A gimbal that refused to aim because it could not also watch
  // would trade the feature it exists for against the one it gained — the degradation has to be the other
  // way round, and `occlusion` then reads { known:false } forever, which the rig already treats as "no
  // opinion" rather than as "clear" (Law 23).
  try { Vec3 = require('vec3'); } catch (e) { Vec3 = null; }

  // How often the sightline is walked, and how many CONSECUTIVE blocked readings before the rig is told the
  // shot is dead. The sample period is itself the debounce for a bot flicking past a fence post: at 500 ms
  // a single reading already means "still blocked half a second later". graceChecks 1 therefore cuts as
  // fast as the cadence allows, which is the intent — raise it to 2 if a bot walking a treeline produces
  // cuts you can feel.
  const occlusionMs = cfg.occlusionMs != null ? cfg.occlusionMs : 500;
  const graceChecks = cfg.graceChecks != null ? cfg.graceChecks : 1;
  const BLOCKERS = visualBlockers || null;

  const gimbals = new Map();

  for (const botName of bots) {
    const username = `${cfg.prefix}${botName}`;
    const g = {
      username,
      target: botName,
      ready: false,
      ended: false,
      bot: null,
      acquired: false,   // first lock-on snaps; subsequent motion eases
      yaw: 0,            // degrees, our own authored orientation — NOT read back from the client, because
      pitch: 0,          //   the server rounds what it echoes and the ease would jitter against that rounding.
      timer: null,
      reconnect: null,
      // The sightline reading the rig polls. `known:false` until the first successful walk, and back to it
      // whenever the subject leaves view distance or a chunk is missing — never a stale verdict wearing a
      // fresh read's face (Invariant B), and never a guess of "clear" for space nobody sensed (Law 23).
      occl: { known: false, clear: true, blockedBy: null, since: 0, streak: 0, at: 0 },
      lastOcclMs: 0,
    };

    const connect = () => {
      if (g.ended) return;
      const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline' });
      g.bot = bot;
      g.ready = false;

      bot.once('spawn', () => {
        // NO CLIENT-SIDE PHYSICS. mineflayer simulates gravity for a SPECTATOR too (physics.js tickPhysics
        // gates simulatePlayer only on this flag, never on gamemode), so the client falls, the server — which
        // knows a spectator floats — corrects it, and the two fight every tick. Observed live 2026-07-21: the
        // gimbal "jumping up and down like a bunny." A gimbal must never move itself; the rig teleports it and
        // it holds. Turning physics off is safe for the aim because the SAME tick still calls updatePosition(),
        // which is gated on shouldUsePhysics ONLY — so rotation packets keep flowing.
        bot.physicsEnabled = false;
        g.ready = true;
        g.acquired = false;
        if (log) log(`${username} online — aiming at ${g.target} (physics off, aim only).`);
        if (g.timer) clearInterval(g.timer);
        g.timer = setInterval(() => tick(g), TICK_MS);
      });

      const down = (why) => {
        g.ready = false;
        // A dropped client's last reading is a fact about a world it is no longer connected to. Leaving it
        // standing would let the rig cut — or refuse to cut — on evidence from before the disconnect, which
        // is exactly the silence-that-reads-as-measurement Law 25 forbids.
        g.occl = { known: false, clear: true, blockedBy: null, since: 0, streak: 0, at: 0 };
        if (g.timer) { clearInterval(g.timer); g.timer = null; }
        // Reconnect unless the rig ended us deliberately — a server restart drops the gimbal exactly as it
        // drops the scout and the rig's RCON link, and both of those re-link.
        if (!g.ended && !g.reconnect) {
          g.reconnect = setTimeout(() => { g.reconnect = null; connect(); }, 5000);
        }
      };
      bot.on('end', down);
      bot.on('error', () => {});   // 'end' always follows; swallowing here only stops an unhandled throw
      bot.on('kicked', () => {});
    };

    connect();
    gimbals.set(botName, g);
  }

  // One tick of aim: find the subject, compute the angle to it, apply dead zone + ease + rate cap, send.
  function tick(g) {
    if (!g.ready || !g.bot) return;
    try {
      const me = g.bot.entity && g.bot.entity.position;
      const other = g.bot.players[g.target];
      const tgt = other && other.entity && other.entity.position;
      if (!me || !tgt) return;   // subject not in view-distance / not spawned — hold the last aim, do not swing

      // Measure from the EYE, not the feet — mineflayer's own lookAt offsets by eyeHeight, and skipping it
      // tilts every shot down by ~1.6 blocks of parallax at close range (which is all we shoot now).
      const eyeY = me.y + (g.bot.entity.eyeHeight || 1.62);
      const dx = tgt.x - me.x;
      const dy = (tgt.y + cfg.aimRise) - eyeY;
      const dz = tgt.z - me.z;
      const flat = Math.hypot(dx, dz);
      if (flat < 1e-3 && Math.abs(dy) < 1e-3) return;

      // MINEFLAYER'S convention, read from physics.js bot.lookAt — NOT the protocol/RCON one:
      //   yaw = atan2(-dx, -dz)   pitch = atan2(dy, groundDist), POSITIVE = UP.
      // The rig's aimAt() uses the OTHER one (-atan2(dx,dz), +pitch = DOWN) because it feeds `tp … yaw pitch`.
      // Mixing them is exactly why the first build stared off into space with the pitch inverted; mineflayer
      // converts to Notchian itself, so handing it protocol angles is a silent, well-formed lie.
      const wantYaw = Math.atan2(-dx, -dz) / RAD;
      const wantPitch = Math.atan2(dy, flat) / RAD;

      if (!g.acquired) {
        // SNAP. This fires on first lock-on AND on every cut (the rig calls snap()), which is what makes a cut
        // read as a CUT: the camera teleports and is instantly on the bot. Easing into a new shot would turn
        // every cut into a swing — the thing that made the constant-gimbal build look like a rookie operator.
        g.yaw = wantYaw; g.pitch = wantPitch; g.acquired = true;
        g.correctingYaw = false; g.correctingPitch = false;
      } else {
        g.yaw = step(g, 'correctingYaw', g.yaw, wantYaw, true, cfg.deadzoneYawDeg);
        g.pitch = step(g, 'correctingPitch', g.pitch, wantPitch, false, cfg.deadzonePitchDeg);
      }
      g.bot.look(g.yaw * RAD, g.pitch * RAD, true);

      // ── THE WATCH. Same tick, own clock. ──────────────────────────────────────────────────────
      // It rides the aim tick rather than a second interval because it needs exactly what the aim just
      // computed — this eye, that subject, both fresh — and a separate timer would re-derive them a few
      // milliseconds out of step for no gain (Law 8: one loop, one owner). `occlusionMs` throttles it
      // independently, so the aim keeps its 20 Hz and the walk runs at 2.
      const nowMs = Date.now();
      if (Vec3 && nowMs - g.lastOcclMs >= occlusionMs) {
        g.lastOcclMs = nowMs;
        const bot = g.bot;
        // FROM THE EYE, TO THE CHEST — the same two points the aim above just used. If the walk started at
        // the feet it would measure a sightline 1.62 blocks below the one being filmed, and would call a
        // shot over a wall blocked and a shot under a branch clear, both backwards.
        const los = walkLine((x, y, z) => bot.blockAt(new Vec3(x, y, z)),
                             { x: me.x, y: eyeY, z: me.z },
                             { x: tgt.x, y: tgt.y + cfg.aimRise, z: tgt.z },
                             BLOCKERS);
        if (!los.known) {
          g.occl = { known: false, clear: true, blockedBy: null, since: 0, streak: 0, at: nowMs };
        } else if (los.clear) {
          g.occl = { known: true, clear: true, blockedBy: null, since: 0, streak: 0, at: nowMs };
        } else {
          const streak = g.occl.known && !g.occl.clear ? g.occl.streak + 1 : 1;
          g.occl = { known: true, clear: false, blockedBy: los.blockedBy,
                     since: g.occl.since || nowMs, streak, at: nowMs };
        }
      }
    } catch (e) {
      // A world/entity read can throw while chunks stream. Holding the previous aim for a tick is correct;
      // killing the interval would silently freeze the camera for the rest of the run.
    }
  }

  // One axis of the hold-still-then-rescue behaviour. Two states, and the hysteresis between them is the
  // whole design: HOLDING (camera perfectly motionless while the bot drifts) until the error passes the dead
  // zone, then CORRECTING toward centre until the error is back inside deadzone×recenterFrac.
  // Easing only to the dead-zone BOUNDARY (the previous version) leaves the subject sitting exactly on the
  // trigger, so the very next tick re-fires — a permanent stream of micro-corrections, which is precisely the
  // fidgety "rookie recorder" look. Release well inside the zone and the camera gets to be still again.
  function step(g, stateKey, cur, want, wrap, deadzone) {
    const err = wrap ? shortestDeg(want - cur) : (want - cur);
    const mag = Math.abs(err);
    if (!g[stateKey]) {
      if (mag <= deadzone) return cur;                        // holding — do not move at all
      g[stateKey] = true;                                     // bot reached the edge: begin the rescue
    } else if (mag <= deadzone * cfg.recenterFrac) {
      g[stateKey] = false;                                    // comfortably re-framed: lock still again
      return cur;
    }
    let delta = err * cfg.easePerTick;                        // ease toward CENTRE, not the boundary
    const cap = cfg.maxRateDegPerTick;
    if (delta > cap) delta = cap; else if (delta < -cap) delta = -cap;
    return cur + delta;
  }

  return {
    available: true,
    get: botName => gimbals.get(botName) || null,
    isReady: botName => { const g = gimbals.get(botName); return !!(g && g.ready); },
    nameFor: botName => `${cfg.prefix}${botName}`,

    // occlusion(bot) -> { known, clear, blockedBy, blockedMs }
    //
    // A READING, NOT A VERDICT — see the header. `clear:false` means the line from this lens to that
    // subject has been continuously blocked for `graceChecks` consecutive walks; anything the rig wants to
    // weigh against that (minimum hold, a travel leg still in progress, a see-through tripod) is the rig's,
    // and this file deliberately knows none of it.
    //
    // A reading older than three sample periods is DISCARDED rather than returned. The tick that produces
    // it is the same tick that aims, so it stops when the subject leaves view distance or the client drops
    // — and a stale "clear" would then hold a dead shot open forever while looking like a live instrument
    // (Law 25). Staleness reads as `known:false`, which the rig treats as no opinion.
    occlusion: botName => {
      const g = gimbals.get(botName);
      if (!g || !g.ready || !g.occl.known) return { known: false };
      if (Date.now() - g.occl.at > occlusionMs * 3) return { known: false };
      if (g.occl.clear || g.occl.streak < graceChecks) {
        return { known: true, clear: true, blockedBy: null, blockedMs: 0 };
      }
      return { known: true, clear: false, blockedBy: g.occl.blockedBy,
               blockedMs: Date.now() - g.occl.since };
    },
    // snap: drop the eased state so the NEXT tick points straight at the subject. The rig calls this on every
    // cut, so a cut is a teleport + an instant re-aim — a hard cut, never a pan into the new shot.
    snap: botName => { const g = gimbals.get(botName); if (g) g.acquired = false; },
    endAll: () => {
      for (const g of gimbals.values()) {
        g.ended = true;
        if (g.timer) clearInterval(g.timer);
        if (g.reconnect) clearTimeout(g.reconnect);
        try { g.bot && g.bot.quit(); } catch (e) { /* already gone */ }
      }
    },
  };
}

module.exports = { createGimbals };
