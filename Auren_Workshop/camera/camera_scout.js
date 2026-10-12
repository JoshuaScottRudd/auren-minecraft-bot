// camera_scout — headless mineflayer client that joins the server only to read the world (Law 19). Gives
// the camera rig a live world model for raycast, which a pure RCON + file-read rig has none of. Answers
// entityPos (where a bot is), castVisibilityField (open sightlines around a bot), and coneClear (does a
// spot film the target cleanly). Renders nothing, so it is not the camera — the Prism spectator client is.
//
// Module resolution goes through @utils/node_module_homes (Law 16). If the require fails, createScout
// returns { available:false } and the rig runs without raycast.
//
// Ray loops yield through the fleet's pacer (js_kernel/utils/execution_yield, Law 16): a synchronous
// ray loop would block the event loop this client's packet handlers run on, delaying entitySwingArm/
// entityHurt/damage_event past the instant they measure. Constructed with no bot, so the pacer's combat
// gate is off (Law 19). onBlindSpan stamps every span spent in blocking work, so a reader can tell "the
// camera was busy here" from silence meaning nothing happened (Law 25).

'use strict';

const { isOpaque, walkLine } = require('./sightline');
const paths = require('../workshop_paths');
const { makeExecutionPacer } = require(paths.bot('js_kernel/utils/execution_yield'));
const { bootstrapModulePath } = require(paths.bot('js_kernel/utils/node_module_homes'));

// createScout: returns a scout handle. Never throws — on require/connection failure returns
// { available:false, reason } and the rig checks .available.
function createScout({ host, port, version, username, onReady, onEnd, log, scanSliceMs }) {
  let mineflayer, Vec3;
  try {
    bootstrapModulePath();
    mineflayer = require('mineflayer');
    Vec3 = require('vec3');
  } catch (e) {
    // The stub mirrors the live handle's shape (async where it's async) but degrades permissively:
    // airClear true, blockAt null — a missing scout must never read as "the world is empty".
    return { available: false, reason: e.message, isReady: () => false, entityPos: () => null,
             selfPos: () => null,
             coneClear: async () => ({ known: false }), airClear: () => true, frontClear: () => true,
             blockAt: () => null,
             biomeAt: () => ({ known: false }),
             entitySnapshot: () => ({ known: false, entities: [] }), onObserved: () => {},
             onBlindSpan: () => {}, blindStats: () => ({ spans: 0, blockedMs: 0 }),
             aggroLineOfSight: () => ({ known: false }),
             castVisibilityField: async () => ({ known: false }), end: () => {} };
  }

  const state = { bot: null, ready: false, ended: false, reconnectTimer: null, observers: [],
                  blindListeners: [], blindSpans: 0, blockedMs: 0 };

  // One pacer for the whole scout, so concurrent ray loops share a single slice clock.
  const pace = makeExecutionPacer({ sliceMs: Math.max(1, scanSliceMs || 8) });

  // beginBlindSpan(what) -> end(detail): returns its own closer so a span cannot be left open (Law 8).
  function beginBlindSpan(what) {
    const startedAt = Date.now();
    return function endBlindSpan(detail) {
      const endedAt = Date.now();
      const ms = endedAt - startedAt;
      state.blindSpans++;
      state.blockedMs += ms;
      if (!state.blindListeners.length) return;
      const rec = { what, startedAt, endedAt, ms, ...(detail || null) };
      for (const fn of state.blindListeners) {
        try { fn(rec); } catch (err) { if (log) log('warn', `scout blind-span listener threw: ${err.message}`); }
      }
    };
  }

  // isOpaque/walkLine live in ./sightline (Law 16); this closure just supplies this client's Vec3/world.
  const blockAtXYZ = bot => (x, y, z) => bot.blockAt(new Vec3(x, y, z));

  // emitObserved: fan a server-sent packet out to observers, unmodified plus the entity's position.
  function emitObserved(type, e, extra) {
    if (!e || !state.observers.length) return;
    const at = Date.now();
    const rec = {
      type, at,
      id: e.id,
      name: e.name || e.mobType || null,
      username: e.username || null,
      position: e.position ? { x: e.position.x, y: e.position.y, z: e.position.z } : null,
      velocity: e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null,
      health: typeof e.health === 'number' ? e.health : null,
      ...(extra || null),
    };
    for (const fn of state.observers) {
      try { fn(rec); } catch (err) { if (log) log('warn', `scout observer threw: ${err.message}`); }
    }
  }

  function connect() {
    if (state.ended) return;
    const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline' });
    state.bot = bot;
    state.ready = false;

    bot.once('spawn', () => {
      state.ready = true;
      if (onReady) onReady();
    });
    const down = (why) => {
      if (!state.ready && !state.bot) return;
      state.ready = false;
      if (onEnd) onEnd(why);
      // Reconnect unless the rig ended us on purpose.
      if (!state.ended && !state.reconnectTimer) {
        state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connect(); }, 5000);
      }
    };
    // Swing/hit timing: read once here, at the packet (Law 26).
    // Re-attached inside connect() since a server restart replaces the mineflayer bot (Law 25).
    bot.on('entitySwingArm', (e) => emitObserved('swing_arm', e));
    bot.on('entityDead', (e) => emitObserved('dead', e));

    // `entityHurt` carries only the victim; the raw `damage_event` packet also carries the damage type
    // and the projectile, so those two fields are stashed here by entity id (resolved later by the
    // reducer against the entities it tracks) and merged into the `entityHurt` record below (Law 16).
    // Prepended so the stash exists before mineflayer's own handler fires `entityHurt`.
    const damageMeta = new Map();
    bot._client.prependListener('damage_event', (p) => {
      damageMeta.set(p.entityId, {
        sourceTypeId: p.sourceTypeId,
        // Protocol writes 0 for "no entity" and offsets real ids by one; a raw 0 must decode to absence.
        directId: p.sourceDirectId ? p.sourceDirectId - 1 : null,
      });
    });
    bot.on('entityHurt', (e, source) => {
      // No stash → fields absent, reading as unknown (Law 25).
      const meta = e ? damageMeta.get(e.id) : null;
      if (e) damageMeta.delete(e.id);
      emitObserved('hurt', e, {
        byId: source ? source.id : null,
        // Username first: entity.name is the entity TYPE, and every player reads 'player' by it.
        byName: source ? (source.username || source.name || source.mobType || null) : null,
        ...(meta || null),
      });
    });

    bot.on('end', (r) => down(`end: ${r}`));
    bot.on('kicked', (r) => down(`kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`));
    // Logs the error and reconnects, keeping an unhandled 'error' event from crashing the rig.
    bot.on('error', (e) => { if (log) log('warn', `scout socket error: ${e.message}`); down(`error: ${e.message}`); });
  }

  connect();

  return {
    available: true,
    isReady: () => state.ready,

    // Where a bot is right now, or null when out of the scout's loaded range.
    entityPos(name) {
      if (!state.ready) return null;
      const p = state.bot.players && state.bot.players[name] && state.bot.players[name].entity
        && state.bot.players[name].entity.position;
      return p ? { x: p.x, y: p.y, z: p.z } : null;
    },

    // Where the scout itself is — a client is absent from its own `players` map, so entityPos can't ask.
    selfPos() {
      if (!state.ready) return null;
      const p = state.bot.entity && state.bot.entity.position;
      return p ? { x: p.x, y: p.y, z: p.z } : null;
    },

    // aggroLineOfSight: transcribes terrain_predicates.hasLineOfSight (threat_scanner's aggro check),
    // kept as a separate copy so the bench evaluates independently of the construct (Law 26). Ray starts
    // at feet + 1.5 (eye height), target is the block centre, range is min(maxDist + 1, 20) — matching
    // the construct's own clamp exactly. { known:false } when either endpoint is unloaded (Law 23).
    aggroLineOfSight(fromFeet, toBlock, maxDist) {
      if (!state.ready) return { known: false };
      try {
        const bot = state.bot;
        const from = new Vec3(Math.floor(fromFeet.x), Math.floor(fromFeet.y), Math.floor(fromFeet.z));
        const to = new Vec3(Math.floor(toBlock.x), Math.floor(toBlock.y), Math.floor(toBlock.z));
        if (bot.blockAt(from) === null || bot.blockAt(to) === null) return { known: false };
        const start = from.offset(0.5, 1.5, 0.5);
        const target = to.offset(0.5, 0.5, 0.5);
        const dir = target.minus(start);
        const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
        if (len === 0) return { known: true, clear: true, blockedBy: null };
        const norm = new Vec3(dir.x / len, dir.y / len, dir.z / len);
        const range = Math.min(maxDist + 1, 20);
        const hit = bot.world.raycast(start, norm, range);
        return { known: true, clear: !hit, blockedBy: hit ? (hit.name || 'block') : null, distance: len };
      } catch (e) {
        return { known: false, error: e.message };
      }
    },

    // Subscribe to server-sent combat packets. Add-only — the recorder is the only caller (Law 8).
    onObserved(fn) { if (typeof fn === 'function') state.observers.push(fn); },

    // Subscribe to this client's own deaf windows — a separate channel from onObserved, since this is
    // what the observer did to itself, not a world fact (Law 25).
    onBlindSpan(fn) { if (typeof fn === 'function') state.blindListeners.push(fn); },

    // blockedMs is the span total (an upper bound), not time actually spent blocking.
    blindStats: () => ({ spans: state.blindSpans, blockedMs: state.blockedMs }),

    // entitySnapshot: every entity the scout can see this instant, as plain data, kept independent of
    // battle_stations, which must not produce the evidence of its own performance (Law 26).
    // `metadata` is carried raw and uninterpreted.
    entitySnapshot(opts = {}) {
      if (!state.ready) return { known: false, entities: [] };
      try {
        const out = [];
        for (const e of Object.values(state.bot.entities || {})) {
          if (!e || !e.position) continue;
          if (opts.near && opts.radius != null) {
            const d = Math.hypot(e.position.x - opts.near.x, e.position.y - opts.near.y, e.position.z - opts.near.z);
            if (d > opts.radius) continue;
          }
          out.push({
            id: e.id,
            // uuid: mineflayer never fills entity.health for an observed entity, so the observer reads
            // a mob's health over RCON with `data get entity <uuid> Health`.
            uuid: e.uuid || null,
            name: e.name || e.mobType || null,
            type: e.type || null,
            kind: e.kind || null,
            username: e.username || null,
            position: { x: e.position.x, y: e.position.y, z: e.position.z },
            velocity: e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null,
            yaw: e.yaw != null ? e.yaw : null,
            pitch: e.pitch != null ? e.pitch : null,
            health: typeof e.health === 'number' ? e.health : null,
            onGround: e.onGround != null ? e.onGround : null,
            width: e.width != null ? e.width : null,
            height: e.height != null ? e.height : null,
            metadata: e.metadata || null,
            heldItem: e.heldItem ? e.heldItem.name : null,
            equipment: Array.isArray(e.equipment) ? e.equipment.map(i => (i ? i.name : null)) : null,
          });
        }
        return { known: true, entities: out };
      } catch (e) {
        return { known: false, entities: [], error: e.message };
      }
    },

    // blockAt: one cell as a plain-data snapshot, never the live prismarine block (Invariant B), or null
    // when unloaded (Law 23). Fields are pinned to their consumers by name:
    //   name, boundingBox — site_geometry, this file's own isOpaque
    //   position          — pathfinding_utils.classifyFloorInline
    //   shapes            — pathfinding_utils.isFullHeightFloor
    //   diggable          — pathfinding_utils.isCeilingDiggable
    // `position` is cloned, the one field that is a live mutable object.
    blockAt(pos) {
      if (!state.ready) return null;
      try {
        const b = state.bot.blockAt(new Vec3(Math.floor(pos.x) + 0.5, Math.floor(pos.y) + 0.5, Math.floor(pos.z) + 0.5));
        if (!b) return null;
        return {
          name: b.name,
          boundingBox: b.boundingBox,
          position: b.position ? b.position.clone() : new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)),
          shapes: b.shapes,
          diggable: b.diggable,
        };
      } catch (e) {
        return null;
      }
    },

    // coneClear: can the camera at `camPos` film the world point `target` cleanly? Fires a grid×grid
    // frustum of rays sampling the image plane around the target, so a leaf-crowded subject scores low
    // even when the sightline itself is open. Every ray is capped
    // ~1 block short of the target so backdrop does not count. The cross-section is angular (frame
    // half-height = d·tan(fov/2)), so the certified rectangle grows with distance and `frameFraction`
    // means the same fraction of picture at every range; `grid`/`gridH`/`gridV` set sampling resolution
    // only, independent of that area.
    //
    // Returns { known:false } (can't tell) or { known:true, score:0..1, centerClear:bool, blockedBy,
    // attempts, halfExtent, halfExtentH }. score = fraction of clear rays; the rig's gate is score===1 &&
    // centerClear. centerClear = did the centre ray reach the subject (hard gate). halfExtent/halfExtentH
    // = world-blocks from centre to the certified rectangle's top/bottom and left/right edges.
    // opts: { gridH/gridV (odd, default 13×9), fovDeg (vertical FOV, default 70), aspect (default 16/9),
    //   frameFraction (default 0.7), minHalfExtent/maxHalfExtent (clamps), skipOcclusion — the
    //   underground case where a spectator sees through solid blocks, so the view is clear by definition }.
    async coneClear(camPos, target, opts = {}) {
      if (opts.skipOcclusion) return { known: true, score: 1, centerClear: true, blockedBy: null, attempts: [] };
      if (!state.ready) return { known: false };
      // Rectangular because the picture is 16:9 — fovDeg is Minecraft's vertical FOV, horizontal
      // half-angle is atan(tan(fov/2)·aspect); gridH/gridV split so world-space sample spacing is even.
      const fovDeg = opts.fovDeg != null ? opts.fovDeg : 70;              // MC's default VERTICAL FOV
      const aspect = opts.aspect != null ? opts.aspect : 16 / 9;          // frame width / height
      const gridH = opts.gridH || opts.grid || 13;                        // samples across (odd)
      const gridV = opts.gridV || opts.grid || 9;                         // samples down   (odd)
      // frameFraction is a fraction of frame EXTENT, not of frame angle — linear in distance at every FOV.
      const frameFraction = opts.frameFraction != null ? opts.frameFraction : 0.7;
      const minHalf = opts.minHalfExtent != null ? opts.minHalfExtent : 0.9;
      const maxHalf = opts.maxHalfExtent != null ? opts.maxHalfExtent : 10;
      const endSpan = beginBlindSpan('cone_clear');
      try {
        const bot = state.bot;
        // World coordinates, not block-centred: camPos/target are continuous.
        const from = new Vec3(camPos.x, camPos.y, camPos.z);
        const ctr = new Vec3(target.x, target.y, target.z);
        if (!bot.blockAt(from) || !bot.blockAt(ctr)) return { known: false };   // either column not loaded
        const fwd = ctr.minus(from);
        const flen = fwd.norm();
        if (flen < 1e-3) return { known: true, score: 1, centerClear: true, blockedBy: null, attempts: [] };
        const dir = fwd.scaled(1 / flen);
        // Image-plane axes: `right` ⟂ dir and horizontal, `up` = dir × right; falls back to world X
        // near-vertical.
        let right = (Math.abs(dir.x) < 1e-4 && Math.abs(dir.z) < 1e-4) ? new Vec3(1, 0, 0) : new Vec3(dir.z, 0, -dir.x);
        const rl = right.norm(); right = right.scaled(1 / (rl || 1));
        const up = dir.cross(right);
        const halfI = (gridH - 1) / 2;                    // sample index range across (the `right` axis)
        const halfJ = (gridV - 1) / 2;                    // sample index range down   (the `up` axis)
        // Half-extents of the certified rectangle at the target; minHalf/maxHalf clamp near/far shots,
        // horizontal follows aspect.
        const halfExtent = Math.min(maxHalf, Math.max(minHalf,
          flen * Math.tan((fovDeg / 2) * Math.PI / 180) * frameFraction));
        const halfExtentH = halfExtent * aspect;
        // grid is sampling resolution, halfExtent is area — kept decoupled.
        const stepI = halfI > 0 ? halfExtentH / halfI : 0;
        const stepJ = halfJ > 0 ? halfExtent / halfJ : 0;
        const attempts = [];
        let clear = 0, total = 0, centerClear = false, blockedBy = null;
        for (let i = -halfI; i <= halfI; i++) {
          for (let j = -halfJ; j <= halfJ; j++) {
            // Abandoned as unknown, not partial, if a server restart replaces state.bot mid-scan (Law 25).
            if (!state.ready || state.bot !== bot) return { known: false, aborted: 'scout_reconnected' };
            await pace();
            total++;
            const isCenter = i === 0 && j === 0;
            const p = new Vec3(
              ctr.x + right.x * i * stepI + up.x * j * stepJ,
              ctr.y + right.y * i * stepI + up.y * j * stepJ,
              ctr.z + right.z * i * stepI + up.z * j * stepJ);
            const rd = p.minus(from);
            const rlen = rd.norm();
            if (rlen < 1.2) { clear++; if (isCenter) centerClear = true; continue; }
            const hit = bot.world.raycast(from, rd.scaled(1 / rlen), Math.max(0.1, rlen - 1.0));
            if (!hit) { clear++; if (isCenter) centerClear = true; }
            else {
              const name = hit.name || (hit.position && bot.blockAt(hit.position) && bot.blockAt(hit.position).name) || 'block';
              if (!blockedBy) blockedBy = name;
              if (attempts.length < 12) attempts.push({ off: `${i},${j}`, hit: name });
            }
          }
        }
        // walkLine gets a veto pass for visual-only blockers (e.g. sugar cane) the raycast can't see;
        // it can only downgrade centerClear, never grant it.
        if (centerClear && opts.visualBlockers) {
          const los = walkLine(blockAtXYZ(bot), camPos, ctr, opts.visualBlockers);
          if (los.known && !los.clear) {
            centerClear = false;
            if (!blockedBy) blockedBy = los.blockedBy;
          }
        }
        return { known: true, score: clear / total, centerClear, blockedBy, attempts, halfExtent, halfExtentH };
      } catch (e) {
        return { known: false, error: e.message };
      } finally {
        endSpan({ rays: gridH * gridV });
      }
    },

    // airClear: is `pos` the centre of a solid cube of air of the given radius (1 → 3×3×3)? A different
    // question from coneClear, which validates only one bearing to the bot and says nothing about what
    // swings into frame as a gimbal rotates. Cheap on purpose — block lookups only, no raycasts — so it
    // screens candidates before the cone runs. Rounded off to a ball (cells beyond `radius + 0.5`
    // Euclidean distance skipped). Unloaded chunk reads as false, never as air (Law 23).
    airClear(pos, radius = 1, blockers) {
      if (!state.ready) return false;
      try {
        const bot = state.bot;
        const r2 = (radius + 0.5) * (radius + 0.5);
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
              if (dx * dx + dy * dy + dz * dz > r2) continue;      // corner of the cube — too far to matter
              const b = bot.blockAt(new Vec3(pos.x + dx + 0.5, pos.y + dy + 0.5, pos.z + dz + 0.5));
              if (isOpaque(b, blockers)) return false;
            }
          }
        }
        return true;
      } catch (e) {
        return false;
      }
    },

    // frontClear: is there a clear corridor of the given cross-section directly in front of the lens? A
    // third shape: the air box (ball, small) and the cone (fans out from the subject, narrow near the
    // lens) leave a gap a few blocks ahead of the camera that neither tests, so this walks the near
    // field as a rectangular tube of fixed width. `from`/`to` are depths along camera→target; `to` is
    // clamped one block short of the subject, since beyond it is backdrop (allowed to be foliage).
    // Unloaded reads as blocked (Law 23). Block lookups only, no raycasts.
    frontClear(camPos, target, opts = {}) {
      if (!state.ready) return false;
      const half = opts.half != null ? opts.half : 1;         // 1 → a 3×3 cross-section
      const near = opts.from != null ? opts.from : 2;
      const far = opts.to != null ? opts.to : 5;
      try {
        const bot = state.bot;
        const fwd = new Vec3(target.x - camPos.x, target.y - camPos.y, target.z - camPos.z);
        const flen = fwd.norm();
        if (flen < 1e-3) return true;
        const dir = fwd.scaled(1 / flen);
        // Same image-plane frame as coneClear.
        let right = (Math.abs(dir.x) < 1e-4 && Math.abs(dir.z) < 1e-4) ? new Vec3(1, 0, 0) : new Vec3(dir.z, 0, -dir.x);
        const rl = right.norm(); right = right.scaled(1 / (rl || 1));
        const up = dir.cross(right);
        const maxD = Math.min(far, Math.floor(flen - 1));      // never test the subject's own cell or past it
        for (let d = near; d <= maxD; d++) {
          for (let i = -half; i <= half; i++) {
            for (let j = -half; j <= half; j++) {
              const x = camPos.x + dir.x * d + right.x * i + up.x * j;
              const y = camPos.y + dir.y * d + right.y * i + up.y * j;
              const z = camPos.z + dir.z * d + right.z * i + up.z * j;
              const b = bot.blockAt(new Vec3(Math.floor(x) + 0.5, Math.floor(y) + 0.5, Math.floor(z) + 0.5));
              if (isOpaque(b, opts.blockers)) return false;
            }
          }
        }
        return true;
      } catch (e) {
        return false;
      }
    },

    // biomeAt: which biome owns this cell. Transcribes biome_scanner's getBiomeName logic locally
    // (Law 26). Unloaded returns { known: false }, never a name (Law 23).
    biomeAt(pos) {
      if (!state.ready) return { known: false };
      try {
        const id = state.bot.world.getBiome(new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)));
        if (id == null) return { known: false };
        const name = ((state.bot.registry && state.bot.registry.biomes && state.bot.registry.biomes[id]
          && state.bot.registry.biomes[id].name) || '').replace('minecraft:', '').toLowerCase();
        return name ? { known: true, biome: name } : { known: false };
      } catch (e) {
        return { known: false, error: e.message };
      }
    },

    // lineClear: is the line from `from` to `to` free of anything a viewer would see through? See
    // ./sightline for the hand-walked algorithm.
    lineClear(from, to, blockers) {
      if (!state.ready) return { known: false };
      try { return walkLine(blockAtXYZ(state.bot), from, to, blockers); }
      catch (e) { return { known: false }; }
    },

    // castVisibilityField: fires rays outward from the subject across a full azimuth ring × several
    // upward elevations and reports, per direction, how far until a block — a map of open sightlines the
    // rig turns into camera candidates.
    // opts: { azSteps, elevs:[deg…] (0 = level, + = up), maxRange, from:{x,y,z} aim point }.
    // Returns { known:false } or { known:true, rays:[{ az(deg), elev(deg), dir:{x,y,z}, clearDist }],
    // maxRange }; clearDist is the open distance in that direction (=maxRange if the ray never hit).
    async castVisibilityField(from, opts = {}) {
      if (!state.ready) return { known: false };
      const azSteps = opts.azSteps || 24;
      const elevs = opts.elevs || [0, 12, 25, 40, 58];
      const maxRange = opts.maxRange || 24;
      const endSpan = beginBlindSpan('visibility_field');
      try {
        const bot = state.bot;
        // World coordinates, no block-centring offset.
        const origin = new Vec3(from.x, from.y, from.z);
        if (!bot.blockAt(origin)) return { known: false };        // subject's column not loaded
        const rays = [];
        for (let ai = 0; ai < azSteps; ai++) {
          const az = (ai / azSteps) * 2 * Math.PI;                // MC: x=sin(az), z=cos(az) (matches the rig)
          const sinAz = Math.sin(az), cosAz = Math.cos(az);
          for (const elevDeg of elevs) {
            if (!state.ready || state.bot !== bot) return { known: false, aborted: 'scout_reconnected' };
            await pace();
            const el = elevDeg * Math.PI / 180;
            const ce = Math.cos(el), se = Math.sin(el);
            const dir = new Vec3(ce * sinAz, se, ce * cosAz);
            const hit = bot.world.raycast(origin, dir, maxRange);
            let clearDist = maxRange;
            if (hit) {
              const p = hit.intersect || (hit.position && hit.position.offset(0.5, 0.5, 0.5));
              clearDist = p ? origin.distanceTo(p) : maxRange;
            }
            rays.push({ az: az * 180 / Math.PI, elev: elevDeg, dir: { x: dir.x, y: dir.y, z: dir.z }, clearDist });
          }
        }
        return { known: true, rays, maxRange };
      } catch (e) {
        return { known: false, error: e.message };
      } finally {
        endSpan({ rays: azSteps * elevs.length });
      }
    },

    end() {
      state.ended = true;
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
      try { if (state.bot) state.bot.quit(); } catch (_) { /* best effort */ }
    },
  };
}

module.exports = { createScout };
