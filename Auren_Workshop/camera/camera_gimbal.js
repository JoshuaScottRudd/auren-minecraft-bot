// camera_gimbal — the aim half of the film crew. One headless mineflayer client per camera whose HEAD is
// pointed at the bot every tick; the Prism camera client /spectate's it and renders that head orientation.
// The rig owns WHERE to stand and WHEN to cut; this file owns only WHERE THE LENS POINTS — a locked tripod
// freezes aim at the cut, so a traversing bot drifts out of frame until the next cut; continuous aim holds it.
//
// An entity, not the camera itself: Minecraft clients interpolate the rotation of entities they watch but
// never the local player's, so a camera SPECTATING a rotating entity smooths to render framerate, where a
// camera rotated directly by `tp … <yaw> <pitch>` steps at 20 Hz.
//
// Eases instead of snapping (load-bearing taste): pointing exactly at the bot every tick reads as a turret
// and transmits the bot's own micro-jitter. A DEAD ZONE the bot may drift inside with the camera still, then
// an exponential ease that lags on a sudden move and settles without overshoot. `easePerTick: 1` with
// `deadzoneDeg: 0` reproduces the turret exactly — the debug setting, not a look.
//
// ── ALSO WATCHES ITS OWN SIGHTLINE ──────────────────────────────────────────────────────────────────
// Parked at the lens, so unlike the scout (parked elsewhere, often at the edge of its own view distance)
// its loaded chunks are guaranteed to be the ones the picture is made of. Twice a second it walks the line
// from its own eye to the subject and reports whether the shot still has a subject in it.
//
// IT REPORTS; IT DOES NOT CUT (Law 16). Whether to cut depends on context this file cannot see — a travel
// leg mid-journey, a see-through tripod underground, how long the shot has held — so it exposes a reading
// and the rig decides.
//
// A line, not the cone: the cone grades the FRAME (canopy-free fraction, 117 rays, affordable every 5s);
// this asks the cruder question of whether the bot is visible at all (~20 block lookups, cheap at 2 Hz).
// The two fail differently — a shot can hold a perfectly visible bot in a frame that is otherwise foliage.
//
// The walk itself is ./sightline, shared with the scout, so both use one definition of "blocked" (Law 16).
//
// Module resolution + graceful degradation mirror camera_scout: mineflayer resolves through whichever
// module home node_module_homes names for this machine, and a missing require or connection returns
// { available:false } so the rig falls back to the frozen-aim tripod.

'use strict';

const path = require('path');
const fs = require('fs');
const { walkLine } = require('./sightline');

// Resolves mineflayer's module home the same way every client does, through node_module_homes (Law 16 —
// one shared answer for where the modules live). Returns whether a home was found.
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
  // vec3 addresses a cell for the sightline walk only, so it is required separately: its absence costs
  // the watch alone, never the aim. `occlusion` then reads { known:false } forever, which the rig treats
  // as no opinion, never as clear (Law 23).
  try { Vec3 = require('vec3'); } catch (e) { Vec3 = null; }

  // How often the sightline is walked (occlusionMs), and how many CONSECUTIVE blocked readings
  // (graceChecks) before the rig is told the shot is dead — the sample period is itself the debounce for
  // a bot flicking past a fence post.
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
      // The sightline reading the rig polls. `known:false` until the first successful walk, and again
      // whenever the subject leaves view distance or a chunk is missing (Invariant B, Law 23).
      occl: { known: false, clear: true, blockedBy: null, since: 0, streak: 0, at: 0 },
      lastOcclMs: 0,
    };

    const connect = () => {
      if (g.ended) return;
      const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline' });
      g.bot = bot;
      g.ready = false;

      bot.once('spawn', () => {
        // NO CLIENT-SIDE PHYSICS: mineflayer simulates gravity for a SPECTATOR too (physics.js gates
        // simulatePlayer on this flag, never gamemode), so an un-corrected client fights the server's own
        // floor correction every tick. A gimbal must never move itself; the rig teleports it and it holds.
        // Turning physics off is safe for the aim because updatePosition() is gated on shouldUsePhysics
        // only, so rotation packets keep flowing.
        bot.physicsEnabled = false;
        g.ready = true;
        g.acquired = false;
        if (log) log(`${username} online — aiming at ${g.target} (physics off, aim only).`);
        if (g.timer) clearInterval(g.timer);
        g.timer = setInterval(() => tick(g), TICK_MS);
      });

      const down = (why) => {
        g.ready = false;
        // A dropped client's last reading describes a world it has lost its connection to; resetting it
        // stops the rig acting on stale evidence (Law 25).
        g.occl = { known: false, clear: true, blockedBy: null, since: 0, streak: 0, at: 0 };
        if (g.timer) { clearInterval(g.timer); g.timer = null; }
        // Reconnects unless the rig ended us deliberately — a server restart drops the gimbal the same way
        // it drops the scout and the rig's RCON link, and all three re-link.
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

      // Measure from the EYE, not the feet: mineflayer's own lookAt offsets by eyeHeight, and skipping it
      // tilts every shot down by ~1.6 blocks of parallax at close range.
      const eyeY = me.y + (g.bot.entity.eyeHeight || 1.62);
      const dx = tgt.x - me.x;
      const dy = (tgt.y + cfg.aimRise) - eyeY;
      const dz = tgt.z - me.z;
      const flat = Math.hypot(dx, dz);
      if (flat < 1e-3 && Math.abs(dy) < 1e-3) return;

      // MINEFLAYER'S convention, read from physics.js bot.lookAt — NOT the protocol/RCON one:
      //   yaw = atan2(-dx, -dz)   pitch = atan2(dy, groundDist), POSITIVE = UP.
      // The rig's aimAt() uses the OTHER one (-atan2(dx,dz), +pitch = DOWN) because it feeds `tp … yaw pitch`;
      // mineflayer converts to Notchian itself, so handing it protocol angles is a silent, well-formed lie.
      const wantYaw = Math.atan2(-dx, -dz) / RAD;
      const wantPitch = Math.atan2(dy, flat) / RAD;

      if (!g.acquired) {
        // SNAP: fires on first lock-on and on every cut (the rig calls snap()), so a cut reads as a CUT —
        // the camera teleports and is instantly on the bot, never easing into the new shot.
        g.yaw = wantYaw; g.pitch = wantPitch; g.acquired = true;
        g.correctingYaw = false; g.correctingPitch = false;
      } else {
        g.yaw = step(g, 'correctingYaw', g.yaw, wantYaw, true, cfg.deadzoneYawDeg);
        g.pitch = step(g, 'correctingPitch', g.pitch, wantPitch, false, cfg.deadzonePitchDeg);
      }
      g.bot.look(g.yaw * RAD, g.pitch * RAD, true);

      // ── THE WATCH. Same tick, own clock (Law 8: one loop, one owner). ──────────────────────────
      // Rides the aim tick because it needs exactly what the aim just computed — this eye, that subject,
      // both fresh. `occlusionMs` throttles it independently, so the aim keeps its 20 Hz and the walk runs
      // at 2.
      const nowMs = Date.now();
      if (Vec3 && nowMs - g.lastOcclMs >= occlusionMs) {
        g.lastOcclMs = nowMs;
        const bot = g.bot;
        // FROM THE EYE, TO THE CHEST — the same two points the aim above just used, so the walk measures
        // the sightline actually being filmed, not one 1.62 blocks off.
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

  // One axis of the hold-still-then-rescue behaviour: HOLDING (camera motionless while the bot drifts)
  // until the error passes the dead zone, then CORRECTING toward centre until the error is back inside
  // deadzone×recenterFrac — releasing only at the boundary would leave the subject sitting on the
  // trigger, re-firing every tick.
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
    // A READING, NOT A VERDICT (see header): `clear:false` means the sightline has been continuously
    // blocked for `graceChecks` consecutive walks; weighing that against a minimum hold, a travel leg, or
    // a see-through tripod is the rig's job, never this file's.
    //
    // A reading older than three sample periods reads as `known:false`, since a stale clear would hold a
    // dead shot open forever while looking like a live instrument (Law 25).
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
