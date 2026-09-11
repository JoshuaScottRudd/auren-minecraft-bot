// camera_scout — the film crew's eyes. A headless mineflayer client that joins the server ONLY
// to read the world: it never moves itself by intent, never touches a bot, decides nothing in any
// SPA loop (Law 19 — an observer of the shared world, like the rig and trace_monitor). It exists
// because bot.world.raycast (terrain_predicates.hasLineOfSight) needs a live world model, and the
// camera rig — pure RCON + file reads — has none. The scout has one; the rig asks it three things:
//   entityPos(bot)          — where a bot is right now (continuous, ~20 Hz, smoother than RCON polling)
//   castVisibilityField(…)  — the SENSE step: fire rays OUTWARD from the bot to map where the open
//                             sightlines are, so the rig places cameras at real openings instead of guessing
//   coneClear(…)            — confirm a chosen spot films the target cleanly: a small FRUSTUM of rays (not
//                             one), so a leaf-crowded subject scores low even when the center line is open
//
// The scout renders nothing (headless), so it cannot be the camera — the Prism spectator client
// is the camera. Two roles, both required. The rig parks the scout high and spectator via RCON so
// it never falls, dies, or appears in frame; the scout itself only reads.
//
// Module resolution goes through @utils/node_module_homes — the ONE answer to where mineflayer and vec3
// live on this machine. It used to be a private loop here that knew only about node_env2, which made
// this file (and therefore every camera process) silently primary-workstation-only: the three tools that
// borrow the scout boot the wide list themselves before requiring it, so nobody noticed for as long as
// the scout's only job was filming, and filming only ever happened at home. That resolver's header has
// the full account. If the require still fails, createScout returns { available:false } and the rig runs
// without raycast — filming must survive a missing scout (it is an enhancement, not the construct).
//
// ── THE RAY LOOPS YIELD, AND THAT IS WHAT MAKES THIS CLIENT AN OBSERVER ────────────────────────────
// Camera angles change on the order of seconds, which leaves plenty of slack to slow raycasting down
// with a cooperative yield rather than run it solid.
//
// A synchronous ray loop blocks the Node event loop, and this client's packet handlers ARE event-loop
// callbacks. So every millisecond spent inside castVisibilityField / coneClear is a millisecond in
// which `entitySwingArm`, `entityHurt` and `damage_event` cannot fire — they queue, and their arrival
// timestamps land after the loop returns. That is fatal specifically for THIS client, whose whole
// value is instants measured to the tick: a large field solve can skew arrival timestamps by a full
// second or more against a record whose questions are decided in 200 ms windows.
//
// The fix is the fleet's own pacer (js_kernel/utils/voxel_scan_throttle), not a new one — it is the
// ONE cooperative pacer for any loop that reads hundreds of voxels (Law 16). It is constructed with NO
// bot, which switches off its combat gate: that gate exists to drag a live body into battle_stations
// mid-scan, and this client has no body, no battle_stations, and no vote in any SPA loop (Law 19).
// `scanSliceMs` is deliberately far under the pacer's 50 ms default — a full-tick slice is exactly one
// tick of deafness, which is the unit this record measures in. A smaller slice hears more inbound beats
// at the cost of stretching the overall loop; the trade is tunable and the numbers behind it live in
// camera_configure.
//
// ── AND IT STAMPS ITS OWN DEAF SPANS ────────────────────────────────────────────────────────────────
// Yielding narrows the gaps; it does not remove them. So the scout announces every span in which it
// was doing blocking work (onBlindSpan). A reader of the combat record must be able to tell "the
// camera was thinking here" from "nothing happened here" — without the stamp those two are the same
// silence, and the second one is a false measurement (Law 25).

'use strict';

const { isOpaque, walkLine } = require('./sightline');
const paths = require('../workshop_paths');
const { makeScanThrottle } = require(paths.bot('js_kernel/utils/voxel_scan_throttle'));
const { bootstrapModulePath } = require(paths.bot('js_kernel/utils/node_module_homes'));

// createScout: returns a scout handle. On any require/connection failure returns
// { available:false, reason }. Never throws — the rig checks .available.
function createScout({ host, port, version, username, onReady, onEnd, log, scanSliceMs }) {
  let mineflayer, Vec3;
  try {
    bootstrapModulePath();
    mineflayer = require('mineflayer');
    Vec3 = require('vec3');
  } catch (e) {
    // airClear returns TRUE in the stub (permissive): with no scout the rig already falls through to a blind
    // shot, so a FALSE here would reject every candidate of a search that isn't happening. Degrade to the
    // pre-airbox behaviour, never to "no shot".
    // blockAt returns NULL in the stub, not a fake air cell: the arena's terrain classifier must read a
    // scout-less run as "cannot tell" and refuse to site an arena, never as "the world is empty" and site
    // one everywhere. airClear stays permissive for the opposite reason — see the note below.
    // coneClear/castVisibilityField are `async` in the live handle, so the stub returns promises too —
    // a caller that awaits the real one must not get a bare object here and silently read `.known` off
    // a Promise (which is `undefined`, i.e. a FALSE "can't tell" that looks like the real one).
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

  // ONE pacer for the whole scout, not one per call. Two ray loops running at once then share a single
  // slice clock, so their combined burst is what gets metered — which is the resource actually being
  // protected. No bot is passed: see the header on why this client must never carry the combat gate.
  const pace = makeScanThrottle({ sliceMs: Math.max(1, scanSliceMs || 8) });

  // beginBlindSpan(what) -> end(detail) — the deaf-window stamp. Returns its closer rather than taking a
  // second call, so a span cannot be opened and forgotten (Law 8: what is raised terminates with the
  // owner that raised it, and here the owner is one function body).
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

  // isOpaque and walkLine now live in ./sightline — camera_gimbal re-asks the same question at the lens
  // twice a second, and two copies of "what blocks a view" is exactly the pair that drifts (Law 16). The
  // local blockAt closure is all that stays behind: it is this client's Vec3 and this client's world.
  const blockAtXYZ = bot => (x, y, z) => bot.blockAt(new Vec3(x, y, z));

  // emitObserved: fan a server-sent packet out to whoever is listening. The payload is the packet's
  // OWN content plus the entity's position at that instant — nothing derived, nothing decided, matching
  // entitySnapshot's discipline. A subscriber that throws must not take the scout down with it, so the
  // fan-out is guarded; a broken reader is the reader's failure, not the observer's.
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
      // Reconnect unless the rig ended us on purpose — a server restart kills the scout the same
      // way it drops the rig's RCON link, and the rig re-links, so the scout must too.
      if (!state.ended && !state.reconnectTimer) {
        state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connect(); }, 5000);
      }
    };
    // ── THE OBSERVER'S EAR: second-by-second timing of swings and hits ─────────────────────────────
    //
    // A 20 Hz position sampler cannot see an INSTANT. A swing and a hit are events the server announces
    // once and never again — they are not in any snapshot taken a tick later, so polling for them is not
    // a coarse measurement, it is no measurement. These two packets are where they live.
    //
    // The alternative was the bot reporting its own swing timings, and it is barred by the same ruling
    // that put entitySnapshot on this side of the wall (Law 26): the thing under test must not produce
    // the evidence of its own performance. That constraint is what makes this listener necessary rather
    // than merely convenient — the fleet already KNOWS every one of these facts, and it may not be the
    // one to say them.
    //
    // Re-attached inside connect() on purpose: a server restart drops the scout and it reconnects with a
    // fresh mineflayer bot, so listeners bound once at construction would silently stop firing and the
    // stream would go quiet while still looking healthy (Law 25 — an instrument that stops measuring
    // must not read as one that measured nothing happening).
    bot.on('entitySwingArm', (e) => emitObserved('swing_arm', e));
    bot.on('entityDead', (e) => emitObserved('dead', e));

    // ── WHO THREW IT, FROM THE SERVER RATHER THAN FROM GEOMETRY ────────────────────────────────────
    // `entityHurt` carries the VICTIM and nothing else, so every reader downstream had to guess the
    // attacker — and the only guess available is "the nearest tracked opponent". That guess misattributes
    // any ranged hit (an arrow from a skeleton, say) to whichever tracked body happens to stand closest,
    // including a friendly bot that never swung.
    // The hits lens disclosed the guess honestly, which is the most a reducer can do with a record that
    // never carried the answer (Law 25) — but the record CAN carry it.
    //
    // 1.21's `damage_event` states it outright: the victim, the damage TYPE (arrow / mob_attack /
    // explosion / fall / drowning — "what the damage was from", asked directly), the entity that CAUSED
    // it, and the projectile that DELIVERED it. That is a measurement where the geometry was an
    // inference, and it is the observer's to take: the construct must never be the one to say who hit
    // it (Law 26 — the thing under test does not produce the evidence of its own performance).
    //
    // RAW IDS AND A RAW TYPE INDEX, RESOLVED NOWHERE HERE. The scout's whole discipline is that it
    // forwards the packet's own content and decides nothing (see emitObserved). A registry lookup is a
    // decision, and one this client cannot make reliably anyway — the damage-type registry is sent per
    // server. The reducer resolves ids against the entities it is already tracking; an id it cannot
    // place stays an id, which is a readable gap rather than an invented name.
    //
    // WHY IT IS ON THE RAW CLIENT AND NOT AN EVENT: mineflayer has no `entityDamage` event carrying
    // these fields, so the packet is read where it arrives. If a future mineflayer adds one, this
    // becomes the redundant route and goes (Law 16).
    // ONE EMIT PATH, TWO LISTENERS, AND THE SPLIT IS DELIBERATE (Law 16). mineflayer ALREADY reads
    // `damage_event` and re-emits it as `entityHurt(entity, source)` with the causing entity resolved —
    // so a second emit off the raw packet would put two `hurt` records on the tape for one blow and
    // double every hit count in the reducer. The raw listener below therefore emits NOTHING. It only
    // stashes the two fields mineflayer's event drops on the floor: the damage TYPE and the projectile
    // that carried it. The `entityHurt` handler is the only thing that writes a record.
    //
    // PREPENDED, and that is load-bearing rather than tidy: mineflayer's own handler is registered
    // during createBot, so it runs first and `entityHurt` would fire before the stash existed. Prepending
    // puts the stash ahead of it, which is the only ordering where the fields are there when the record
    // is written.
    const damageMeta = new Map();
    bot._client.prependListener('damage_event', (p) => {
      damageMeta.set(p.entityId, {
        sourceTypeId: p.sourceTypeId,
        // The protocol writes 0 for "no entity" and offsets real ids by one, so a raw 0 is an ABSENCE
        // (fall, drowning, cactus, suffocation) and must never decode to entity 0, which is a real
        // entity. That distinction is the difference between "nothing hit it" and "entity zero hit it".
        directId: p.sourceDirectId ? p.sourceDirectId - 1 : null,
      });
    });
    bot.on('entityHurt', (e, source) => {
      // A blow with no stash is a server that does not send damage_event, or a victim outside the
      // tracked set. The record still goes out with the fields absent — an absent field reads as
      // unknown, which is what it is, where a fabricated one would read as a measurement (Law 25).
      const meta = e ? damageMeta.get(e.id) : null;
      if (e) damageMeta.delete(e.id);
      emitObserved('hurt', e, {
        byId: source ? source.id : null,
        // USERNAME FIRST, and the order is load-bearing rather than stylistic. mineflayer sets
        // `entity.name` to the entity TYPE, so every player — every bot in the fleet — has
        // `name === 'player'`. With `name` read first, a bot that struck a mob was recorded as having
        // been struck by "player", and no consumer could match that against a roster: the whole
        // bot-as-attacker half of the record was unattributable. A mob has no username, so putting it
        // first costs the mob case nothing.
        byName: source ? (source.username || source.name || source.mobType || null) : null,
        ...(meta || null),
      });
    });

    bot.on('end', (r) => down(`end: ${r}`));
    bot.on('kicked', (r) => down(`kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`));
    // mineflayer emits 'error'; an unhandled one would crash the rig — swallow to a log + reconnect.
    bot.on('error', (e) => { if (log) log('warn', `scout socket error: ${e.message}`); down(`error: ${e.message}`); });
  }

  connect();

  return {
    available: true,
    isReady: () => state.ready,

    // Where a bot is right now, or null if the scout can't see it (out of its loaded range —
    // e.g. a bot exploring far past the scout's view-distance). Caller falls back to RCON.
    entityPos(name) {
      if (!state.ready) return null;
      const p = state.bot.players && state.bot.players[name] && state.bot.players[name].entity
        && state.bot.players[name].entity.position;
      return p ? { x: p.x, y: p.y, z: p.z } : null;
    },

    // Where the SCOUT itself is. Separate from entityPos because a client is generally absent from its
    // own `players` entity map, so asking entityPos for its own name returns null. Needed by a siting
    // sweep with no fleet running: the sweep needs a centre with loaded chunks around it, and the scout
    // standing there is both.
    selfPos() {
      if (!state.ready) return null;
      const p = state.bot.entity && state.bot.entity.position;
      return p ? { x: p.x, y: p.y, z: p.z } : null;
    },

    // aggroLineOfSight: "can these two SEE each other" — answered exactly the way the thing under test
    // answers it. This is the arena's third question, and it is the only one that must not be
    // approximated.
    //
    // A DELIBERATE TRANSCRIPTION of terrain_predicates.hasLineOfSight, which threat_scanner calls to decide
    // aggro. It is not a second implementation competing with it (Law 16) — it is the OBSERVER'S COPY of
    // the construct's predicate, and the separation is the point (Law 26): the bench must evaluate the
    // criterion independently to AUTHOR a situation, then read what the construct actually did. Importing
    // the construct's function would need a live bot and the whole alias graph inside an observer, and
    // would also make the bench agree with the code by construction — which is the one thing a bench may
    // never do.
    //
    // THREE DETAILS COPIED EXACTLY, each of which silently breaks the assertion if it drifts:
    //   · the ray starts at feet + 1.5 (eye height), NOT at the feet. A metre and a half decides whether
    //     a one-block lip between two bodies blocks the line.
    //   · the target is the block CENTRE (+0.5 on each axis), not its corner.
    //   · the range is min(maxDist + 1, 20) — the construct's own clamp. A bench testing at 20 blocks
    //     against an unclamped ray would author sightlines the scanner can never confirm.
    // It uses world.raycast for the same reason the original does: raycast stops only on collision
    // SHAPES, so sugar cane and tall grass do not block aggro even though they are opaque on screen.
    // Using this file's own name-walking lineClear here would disagree with the scanner on exactly those
    // blocks, and the bench would report a bot failure that is really a bench failure.
    //
    // Returns { known:false } when either endpoint is unloaded — never a confirmed verdict across space
    // nobody sensed (Law 23, and the original's own Invariant B gate).
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

    // onObserved(fn) — subscribe to the server-sent combat packets (see emitObserved). Add-only: the
    // recorder is the only caller and it lives for one run, so an unsubscribe would be a lifecycle with
    // no user (Law 8 — the scout ends and takes its listeners with it).
    onObserved(fn) { if (typeof fn === 'function') state.observers.push(fn); },

    // onBlindSpan(fn) — subscribe to this client's own deaf windows: every span it spent inside a ray
    // loop, whether or not that loop yielded. Add-only for the same reason onObserved is.
    //
    // IT IS NOT AN `observed` RECORD AND MUST NOT SHARE THAT CHANNEL. Everything on onObserved is a thing
    // the SERVER announced; this is a thing the OBSERVER did to itself. Mixing them would put the
    // instrument's own state into the stream of world facts, and the reader could no longer tell a fight
    // it watched from a fight it was busy during — which is the entire reason this exists.
    onBlindSpan(fn) { if (typeof fn === 'function') state.blindListeners.push(fn); },

    // What this client cost itself, for a trailer line. `blockedMs` is the span total, not the time
    // actually spent blocking — the pacer yields inside it — so it reads as an UPPER BOUND on deafness.
    blindStats: () => ({ spans: state.blindSpans, blockedMs: state.blockedMs }),

    // entitySnapshot: EVERY entity the scout can see this instant, as plain data.
    //
    // WHY IT IS HERE (Law 26, and it is the load-bearing reason — not convenience). The arena needs
    // per-tick combat telemetry: distance at the moment of the swing, hp deltas, the creeper's fuse
    // state. The obvious place to read that is inside battle_stations, and that is exactly the illegal
    // shape — the thing under test would be producing the evidence of its own performance. A simulated
    // guarantee is a deleted guarantee, and grading your own paper is the archetype. The construct
    // therefore records NOTHING new; this outside observer records everything, and the trace keeps its
    // two summary lines per engagement.
    //
    // Law 5 is satisfied by the same split rather than exempted: the maximal stream is not diagnostic
    // logging at all, it is an observer's instrument reading, and it never touches the watcher.
    //
    // `metadata` is carried raw and UNINTERPRETED. mineflayer 4.37.1 keeps entity.metadata and resolves
    // metadataKeys by entity name from the registry, which is the likely route to a creeper's
    // swelling/fuse state — combat gap #4, the one the ladder never checks before baiting. Whether
    // 1.21.5's registry names that key is UNVERIFIED, so nothing here decodes it: the recorder stores
    // what the server sent, and the monitor's fuse read is written against real captured data rather
    // than against an assumption about the key's name.
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
            // `uuid` is the only field here that is not for the reader's model of the fight — it is an
            // ADDRESS. `id` is a per-connection entity number and means nothing outside this client, so
            // a reader that wants a fact the protocol withholds has no way to ask for it. Health is that
            // fact: mineflayer never fills entity.health for an OBSERVED entity (lib/plugins/health.js
            // handles update_health for self only), so the observer reads a mob's health over RCON with
            // `data get entity <uuid> Health`, and a UUID is the only entity selector that names one
            // specific mob. Without this field the observer can see a fight and never know whether the
            // bot landed a single blow.
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

    // blockAt: one cell, as PLAIN DATA — a snapshot of the five fields below, or null when unloaded.
    //
    // WHY IT IS HERE AND NOT A SECOND OBSERVER (Law 16). The arena's terrain classifier needs raw column
    // reads to tell a mountain from a river from a cave roof, and the alternative was a second headless
    // mineflayer client joining the server to read blocks — which is precisely what this file already is.
    // One observer, more questions asked of it.
    //
    // Returns a SNAPSHOT, never the live prismarine block. A caller holding the live object could read a
    // field that mutates under it a tick later, which is remembered state wearing a fresh-read's face
    // (Invariant B). Null on unloaded is the same Law 23 discipline airClear keeps: an unread cell is
    // unknown, and the caller must not be able to mistake it for air.
    //
    // WHICH FIELDS, AND WHY A SNAPSHOT MUST NOT BE NARROWER THAN ITS READERS. It carried only
    // { name, boundingBox } — enough for site_geometry, and silently wrong the moment the arena's
    // reachability gate ran the construct's own A* over this same reader: `classifyFloorInline` reads
    // `block.position` and threw on undefined, and `isFullHeightFloor` reads `block.shapes` and would NOT
    // have thrown — it defaults a shapeless block to full height, so every slab and chest in the world
    // would have read as solid ground and the pathfinder would have planned climbs onto them. The first is
    // a garble (loud, Law 13 caught it in one run); the second is a falsehood (silent, and no form check
    // anywhere would have found it) — the two failure modes Law 26 names, from one narrow snapshot.
    //
    // So the rule this now follows: a snapshot carries every field its consumers read, and the list is
    // pinned to those consumers by name rather than to what looked sufficient.
    //   name, boundingBox — site_geometry (isGround / isPassable), camera_scout's own isOpaque
    //   position          — pathfinding_utils.classifyFloorInline, which offsets it to read upward
    //   shapes            — pathfinding_utils.isFullHeightFloor (partial-height blocks gate climb_up)
    //   diggable          — pathfinding_utils.isCeilingDiggable (only alteration edges, kept for fidelity)
    // `position` is cloned rather than aliased — it is the one field that is a live mutable object, so
    // handing it out would reopen exactly the Invariant B hole the snapshot exists to close.
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

    // coneClear: can the camera at `camPos` FILM the world point `target` cleanly? A single straight
    // ray can read "clear" down its center while leaves crowd the subject on every side — the shot the
    // Architect kept getting ("technically clear but generally obscured"). So instead of one ray we fire
    // a grid×grid FRUSTUM sampling the IMAGE PLANE (perpendicular to the sightline) around the target.
    // Every ray is range-capped ~1 block short of the target so nothing BEHIND it counts (a backdrop is
    // fine — "anything behind the bot is ok").
    //
    // THE CROSS-SECTION IS ANGULAR, NOT FIXED — this is the whole point.
    // It used to be a fixed `spread` of 0.9 world-blocks at the target REGARDLESS of distance, i.e. a
    // ~1.8-block patch — roughly the bot's silhouette. That certifies a SHRINKING fraction of the frame
    // as the camera backs off, which produces two symptoms, one bug from both ends:
    //   · FAR  — the bot is visible but only in a small area, because the certified cone stays small: at
    //            30 blocks the frame spans ~40 blocks of world and only 1.8 of them are vouched for, so
    //            the rest of frame is free to be canopy.
    //   · NEAR — the camera reads as sitting inside the canopy it's shooting from: a camera buried in
    //            leaves with a narrow clear TUNNEL to the bot passed, because the 1.8-block pencil fit
    //            down the tunnel while the rest of frame was foliage.
    // A real lens frames by ANGLE: frame half-height = d·tan(fov/2). So the certified square must grow
    // linearly with distance — then one dial (`frameFraction`) means the same thing at every range:
    // "this fraction of the picture is guaranteed canopy-free." Close shots certify a small world area
    // (correct — the frame is small there) and far shots certify a large one, which is exactly the ask.
    // WRONG TURN TO AVOID: do not "fix" a far shot by raising `grid`. grid is sampling RESOLUTION only;
    // it no longer widens the tested area (they were one dial before and that coupling hid this bug).
    //
    // Returns:
    //   { known:false }  — can't tell (scout down / either column unloaded); caller uses a blind default.
    //   { known:true, score:0..1, centerClear:bool, blockedBy, attempts, halfExtent, halfExtentH }
    //     score       = fraction of rays with a clear line. The rig's GATE is binary (score === 1 &&
    //                   centerClear); this fraction only ranks the rejects when nothing came back clean.
    //     centerClear = did the center ray reach the subject itself (a hard gate — no leaf ON the subject)
    //     halfExtent  = world-blocks from centre to the TOP/BOTTOM edge of the rectangle this vouches for
    //     halfExtentH = the same to the LEFT/RIGHT edge (= halfExtent × aspect)
    // opts: { gridH/gridV (odd, default 13×9 = 117 rays — RESOLUTION ONLY; `grid` still sets both),
    //   fovDeg (camera's VERTICAL FOV, default 70), aspect (frame width/height, default 16/9),
    //   frameFraction (fraction of frame extent certified clean), minHalfExtent/maxHalfExtent (clamps),
    //   skipOcclusion } — skipOcclusion is the UNDERGROUND case: a spectator sees THROUGH solid blocks, so
    //   every view is clear by definition (score 1, no rays fired). Leaves have a solid bounding box, so
    //   bot.world.raycast hits them like any block; the grid is what turns that into a graded obstruction.
    //
    // ASYNC, and the yields are inside the grid loop — see the header. `skipOcclusion` and a down scout
    // return before any span is opened: neither fires a ray, so neither is a deaf window.
    async coneClear(camPos, target, opts = {}) {
      if (opts.skipOcclusion) return { known: true, score: 1, centerClear: true, blockedBy: null, attempts: [] };
      if (!state.ready) return { known: false };
      // The cone is a TRUE CAMERA FRUSTUM: its cross-section is angular, so it grows linearly with
      // distance exactly as the rendered frame does (frame half-height = d·tan(fov/2)). See the
      // header note for the two failure modes a FIXED offset produced.
      //
      // AND IT IS RECTANGULAR, because the picture is. `fovDeg` is Minecraft's VERTICAL field of view;
      // the frame is 16:9, so its horizontal half-angle is atan(tan(fov/2)·aspect) ≈ 51° against the
      // vertical 35°. A SQUARE cone therefore certified 65% of frame height but only 37% of frame width
      // — about a QUARTER of the picture — and three quarters of every "100% clear" frame was never
      // looked at. Sampling the same square with a finer `grid` could not fix that: resolution is not
      // area. So the cross-section carries two half-extents, and the ray budget is split to match
      // (`gridH` wider than `gridV`) so the world-space sample spacing is roughly equal on both axes.
      const fovDeg = opts.fovDeg != null ? opts.fovDeg : 70;              // MC's default VERTICAL FOV
      const aspect = opts.aspect != null ? opts.aspect : 16 / 9;          // frame width / height
      const gridH = opts.gridH || opts.grid || 13;                        // samples across (odd)
      const gridV = opts.gridV || opts.grid || 9;                         // samples down   (odd)
      // frameFraction is a fraction of frame EXTENT, not of frame ANGLE. It used to scale the half-angle
      // (0.7 × 35° = 24.5°), which lands at tan(24.5)/tan(35) = 0.65 of the half-height — so the dial
      // read 0.7 and delivered 0.65, and the gap widened with FOV. A linear fraction means what the
      // name says at every FOV: "this fraction of the picture is guaranteed canopy-free."
      const frameFraction = opts.frameFraction != null ? opts.frameFraction : 0.7;
      const minHalf = opts.minHalfExtent != null ? opts.minHalfExtent : 0.9;
      const maxHalf = opts.maxHalfExtent != null ? opts.maxHalfExtent : 10;
      const endSpan = beginBlindSpan('cone_clear');
      try {
        const bot = state.bot;
        // WORLD COORDINATES, TAKEN AS SUCH. Both of these were centred with a +0.5 on every axis — the
        // convention for a BLOCK cell, and neither of these is one: the rig passes a lens position
        // (eyePt + dir·usable) and a subject's chest (straight off `data get entity Pos`), both
        // continuous. The +0.5 slid the whole test 0.87 blocks diagonally off the sightline it reported
        // on, which in canopy is a leaf's width of lie in the one measurement that exists to catch leaves.
        const from = new Vec3(camPos.x, camPos.y, camPos.z);
        const ctr = new Vec3(target.x, target.y, target.z);
        if (!bot.blockAt(from) || !bot.blockAt(ctr)) return { known: false };   // either column not loaded
        const fwd = ctr.minus(from);
        const flen = fwd.norm();
        if (flen < 1e-3) return { known: true, score: 1, centerClear: true, blockedBy: null, attempts: [] };
        const dir = fwd.scaled(1 / flen);
        // Image-plane axes: `right` ⟂ dir and horizontal (= worldUp × dir); `up` = dir × right completes
        // the orthonormal frame. Degenerate only when dir is near-vertical → fall back to world X.
        let right = (Math.abs(dir.x) < 1e-4 && Math.abs(dir.z) < 1e-4) ? new Vec3(1, 0, 0) : new Vec3(dir.z, 0, -dir.x);
        const rl = right.norm(); right = right.scaled(1 / (rl || 1));
        const up = dir.cross(right);
        const halfI = (gridH - 1) / 2;                    // sample index range across (the `right` axis)
        const halfJ = (gridV - 1) / 2;                    // sample index range down   (the `up` axis)
        // Half-extents of the certified RECTANGLE at the target, world-blocks — angular, from the real
        // frame. Clamped on the vertical: minHalf keeps a very close shot from degenerating to a pencil
        // (it must still vouch for the subject's own silhouette); maxHalf stops a very far shot from
        // demanding a clearing no forest contains, which would flatten every distant candidate's score
        // to noise. The horizontal follows the aspect ratio so the tested region stays frame-shaped
        // through both clamps.
        const halfExtent = Math.min(maxHalf, Math.max(minHalf,
          flen * Math.tan((fovDeg / 2) * Math.PI / 180) * frameFraction));
        const halfExtentH = halfExtent * aspect;
        // grid is RESOLUTION, halfExtent is AREA — deliberately decoupled. They used to be one dial
        // (offset-per-step), so raising sampling density silently widened the tested area too.
        const stepI = halfI > 0 ? halfExtentH / halfI : 0;
        const stepJ = halfJ > 0 ? halfExtent / halfJ : 0;
        const attempts = [];
        let clear = 0, total = 0, centerClear = false, blockedBy = null;
        for (let i = -halfI; i <= halfI; i++) {
          for (let j = -halfJ; j <= halfJ; j++) {
            // The pacer may have handed control back to mineflayer, and mineflayer may have replaced the
            // client under us (a server restart reconnects with a FRESH bot — see connect()). A grid that
            // finished against two different worlds is a score nobody can attribute, so it is abandoned as
            // unknown rather than returned as a partial (Law 25: a truncated scan must not read as a
            // completed one).
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
        // The centre ray answers "is the BOT ITSELF visible", which is the hard gate — so it gets the
        // visual-blocker treatment the raycast structurally cannot give it (see walkLine). Without this a
        // bot standing behind sugar cane reads as perfectly framed, because nothing with a collision shape
        // is in the way. Only run when the raycast already said clear: this can veto, never rescue.
        if (centerClear && opts.visualBlockers) {
          const los = walkLine(blockAtXYZ(bot), camPos, ctr, opts.visualBlockers);
          if (los.known && !los.clear) {
            centerClear = false;
            if (!blockedBy) blockedBy = los.blockedBy;
          }
        }
        // halfExtent is returned so the rig can LOG how much clear air a score actually vouches for —
        // without it, "score 0.9" is unreadable (0.9 of a 2-block patch and 0.9 of a 16-block frame
        // are different claims, and telling them apart is the whole point of this change).
        return { known: true, score: clear / total, centerClear, blockedBy, attempts, halfExtent, halfExtentH };
      } catch (e) {
        return { known: false, error: e.message };
      } finally {
        endSpan({ rays: gridH * gridV });
      }
    },

    // airClear: is `pos` the centre of a solid cube of AIR of the given radius (1 → 3×3×3)?
    //
    // WHY THIS EXISTS, and why it is not the cone again. The cone validates ONE bearing — the corridor from
    // camera to bot — which is all a LOCKED TRIPOD ever needed. Two things break that:
    //   · A camera can sit in a tiny pocket of canopy with a clear corridor to the bot and leaves filling the
    //     rest of the picture — a high cone score even though the frame reads as fully blocked by canopy,
    //     because the corridor genuinely is open. Nothing in the corridor test can see the leaf pressed
    //     against the lens.
    //   · A GIMBAL ROTATES. Whatever sits beside the camera swings into frame when it pans, so a following
    //     camera needs clearance in EVERY direction it may turn toward, not along one bearing.
    // So this is a different question from the cone, not a stricter version of it.
    //
    // Cheap ON PURPOSE: block lookups only, no raycasts (~19 at radius 1, ~81 at radius 2), so it screens
    // candidates BEFORE the cone rather than after — the search gets cheaper and better at the same time.
    //
    // THE CUBE IS ROUNDED OFF, which is what makes radius 2 affordable as a rule rather than a wall. A true
    // 5×5×5 rejects on its far corners, 3.46 blocks out on the diagonal — foliage that subtends almost
    // nothing and reads as depth, not obstruction — so it refused nearly every vantage in forest and the
    // boxed-in fallback then defeated the gate entirely (the reject counts in the rig's sweep line are how
    // that was caught). Cells beyond `radius + 0.5` in EUCLIDEAN distance are skipped, so the volume is a
    // ball: it still rejects a leaf two blocks off any axis, and stops pretending the corners are as close.
    // Unloaded chunk → false: an unknown cell must not read as air (Law 23 — an unverified claim is not a fact;
    // the whole failure class here is "empty because we didn't look").
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

    // frontClear: is there a clear CORRIDOR of the given cross-section directly in front of the lens?
    //
    // THE THIRD SHAPE, and it is a different question from the other two rather than a stricter version of
    // either. The air box is a BALL centred on the camera: omnidirectional, and it has to stay small
    // because a big ball rejects everything in forest. The cone is a FRUSTUM anchored on the subject: it
    // fans out with distance, so near the lens — where a single leaf swallows the whole picture — it is at
    // its narrowest, a few centimetres across at one block out. Between the ball's edge and the cone's
    // narrow waist there is a gap, and that gap is precisely where "the camera is parked in front of a
    // canopy" lives: two to five blocks ahead, off the centre line, filling the frame and touched by
    // nothing that tests anything.
    //
    // So this walks the near field as a rectangular tube of FIXED width — the shape the ball and the
    // frustum both fail to be there. A leaf 3 blocks out subtends ~19° of a 70° frame; at 2 blocks, ~28°.
    // Nothing that big may sit in front of a lens, and no ray needs to be fired to find out.
    //
    // `from`/`to` are depths in blocks along camera→target. It never reaches the subject: `to` is clamped
    // to one block short of it, because everything at and beyond the subject is BACKDROP and a backdrop is
    // allowed to be foliage (the same rule coneClear's range cap encodes). Unloaded reads as blocked, the
    // Law 23 discipline airClear keeps — an unread cell is unknown, never clear.
    // Block lookups only: (2·half+1)² per depth, ~36 for the default 3×3 over four depths.
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
        // Same image-plane frame as coneClear, and deliberately so: this tube must be square to the
        // picture, not to the world, or a diagonal shot tests a rotated rectangle nobody is looking at.
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

    // biomeAt: which biome owns this cell, or { known: false } when the chunk is not loaded.
    //
    // A DELIBERATE TRANSCRIPTION of biome_scanner's `getBiomeName`, and the same seam as aggroLineOfSight
    // one file over: the fragment cannot be imported here because it requires `@kernel/watcher`, so
    // pulling it into the bench would open a construct log file from outside the construct and post the
    // bench's own sweeps into it — reaching into the engine while it turns (Law 26). What is copied is
    // eight lines of registry lookup, not the scanner's job: the scanner's verb is the PATCH MAP (flood
    // fill, centroids, bboxes) for a planner choosing where to work, and none of that is wanted here.
    // The arena asks one question — "what biome is THIS cell" — and it must be answerable per candidate
    // cell during a sweep, which a patch map cannot do without building the whole map first.
    //
    // Unloaded → { known: false }, never a name. The biome hunt teleports this client around to LOAD
    // chunks, so "no answer yet" and "not that biome" are the two states it lives between, and collapsing
    // them would make it stop hunting the moment it arrived somewhere it had not finished reading
    // (Law 23 — an unread cell is unknown, never a verdict).
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

    // lineClear: is the straight line from `from` to `to` free of anything a VIEWER would see through?
    // Both ends are WORLD positions (a lens, a subject's chest) — not block cells. ./sightline has why this
    // is a hand-walked line and not a raycast, and why the blocker list has to exist.
    lineClear(from, to, blockers) {
      if (!state.ready) return { known: false };
      try { return walkLine(blockAtXYZ(state.bot), from, to, blockers); }
      catch (e) { return { known: false }; }
    },

    // castVisibilityField: the seeker's SENSE step. Instead of guessing camera positions and rejecting most
    // (coneClear does that — expensive and blind), this fires rays OUTWARD from the subject across a full
    // azimuth ring × several upward elevations and reports, per direction, how far until a block. That is a
    // map of where the open sightlines ARE: a camera placed along an open ray has a clear line back to the
    // subject, so the rig generates candidates from openings rather than sampling a grid. Upward elevations
    // put the camera above the subject → the down-look. It can only come back empty if the subject is sealed
    // in solid rock. opts: { azSteps, elevs:[deg…] (0 = level, + = up), maxRange, from:{x,y,z} aim point }.
    // Returns { known:false } if the scout/chunk is down, else { known:true, rays:[{ az(deg), elev(deg),
    // dir:{x,y,z}, clearDist }], maxRange }. clearDist is the open distance in that direction (=maxRange if
    // the ray never hit). The rig turns each into a camera spot at min(preferredDist, clearDist − margin).
    // ASYNC for the same reason coneClear is, and it is the heavier of the two — the default field is
    // 24 azimuths × 5 elevations = 120 rays in one burst. See the header.
    async castVisibilityField(from, opts = {}) {
      if (!state.ready) return { known: false };
      const azSteps = opts.azSteps || 24;
      const elevs = opts.elevs || [0, 12, 25, 40, 58];
      const maxRange = opts.maxRange || 24;
      const endSpan = beginBlindSpan('visibility_field');
      try {
        const bot = state.bot;
        // WORLD COORDINATES (the rig hands us `bot feet + camHeight`, continuous). The +0.5-per-axis
        // block-centring that used to sit here was doubly wrong: it displaced the cast origin 0.87 blocks
        // diagonally, AND the rig then placed its candidates along the same directions measured from the
        // UN-displaced point — so the camera never stood in the corridor the ray had proved clear.
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
