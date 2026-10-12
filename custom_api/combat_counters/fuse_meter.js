'use strict';
// fuse_meter — reads the creeper's own server-synched swell_dir field instead of modelling the fuse.
//
// minecraft-data names the creeper's synched entity data as
//
//     [… mob_flags, swell_dir, is_powered, is_ignited]
//
// `swell_dir` is a real, server-synched field that arrives in `entity_metadata`; mineflayer merges it
// into `entity.metadata` by index, so the bot can watch it directly (Law 23).
//
// ── SYNCHED IS THE DIRECTION, NOT THE COUNTER ───────────────────────────────────────────────────────
// Java syncs `swellDir` (−1 or +1), never the `swell` int itself; the vanilla client reconstructs the
// counter by integrating that sign each tick, so this meter answers by direction, not a "fuse: 17/30"
// field.
//
// `CreeperSwellGoal` is asymmetric — it ignites on `distanceToSqr < 9` (3.0 b) but only sets
// `swellDir = -1` on `distanceToSqr > 49` (7.0 b) or a broken line of sight. The gap at the moment the
// sign flips to −1 is the boundary this meter measures; SWELL_RESET_DISTANCE below is that boundary, and
// the reconstructed fuse clock is a by-product of the same measurement.
//
// ── NO WATCHER OF ITS OWN (Invariant D) ─────────────────────────────────────────────────────────────
// battle_stations owns the voice. The reading is taken from passes the arm runs anyway, so sensing the
// fuse spends no extra distance against a live creeper's escape.
//
// The metadata index is resolved from the live registry, the same pattern `archer_calculator.bowDrawState`
// uses: the index is a per-version, per-entity fact mineflayer already carries, so a protocol change
// cannot silently read as a creeper that never swelled.

// ── THREE STATES, NOT A BOOLEAN, for bowDrawState's exact reason ───────────────────────────────────
// An unreadable metadata array is not the same fact as "not swelling"; collapsing them would make a
// sensing failure look identical to a calm creeper (Law 25 — "could not tell" is its own answer). Unread
// passes are counted and reported.
//
// UNDEFINED IS NOT −1, even though −1 is the vanilla default. 1.21.5 sends synched data only for fields
// that differ from their default, so a creeper that has never swelled carries no index 16 at all; that
// absence means "never swelled", not "winding down".
const { livingHealth } = require('@utils/calculators/archer_calculator');
// Every timestamp this meter produces is a millisecond offset from process start, never an epoch, so one
// clock answers every line in this file the same way. Module load is process start, so there is no
// arming step to forget.
const BOOT = Date.now();
const runClock = () => Date.now() - BOOT;

const UP = 1;
const DOWN = -1;

// ── SWELL_RESET_DISTANCE: THE UNWIND BOUNDARY ───────────────────────────────────────────────────────
// Where Java's CreeperSwellGoal flips the sign back to −1: `distanceToSqr > 49`, so 7.0 b. This module
// owns the swell: the meter measures where the sign flips, and this constant is what the measurement is
// graded against.
//
// It drives no behaviour — the shield answers the swell from the live reading, not a distance gate — and
// is read only by this meter's own reporting.
const SWELL_RESET_DISTANCE = 7.0;

// ── SWELL_TO_BLAST_MS: THE DETONATION DEADLINE ──────────────────────────────────────────────────────
// Java's Creeper sets `maxSwell = 30` ticks and detonates when the counter reaches it, so an unbroken
// swell is 1500 ms. This is read from the source, not measured here.
//
// `maxWoundMs`, this file's own measured record, is expected to sit at or below this constant: a swell
// interrupted (the creeper dying, or the bot leaving the ignite radius) times short of a full run, and a
// swell that runs to term detonates instead of being timed. gunner.shieldOrder counts back from this
// deadline; a recorded `maxWoundMs` above it marks the number itself as wrong.
const SWELL_TO_BLAST_MS = 1500;

function swellDir(bot, entity) {
  if (!bot || !entity || !entity.name || !Array.isArray(entity.metadata)) return null;
  const keys = bot.registry && bot.registry.entitiesByName && bot.registry.entitiesByName[entity.name]
    ? bot.registry.entitiesByName[entity.name].metadataKeys : null;
  if (!Array.isArray(keys)) return null;
  const idx = keys.indexOf('swell_dir');
  if (idx < 0) return null;
  const v = entity.metadata[idx];
  if (typeof v !== 'number') return null;
  return v > 0 ? UP : DOWN;
}

// mobId → {
//   dir, since, lastAt, reads, unread,
//   woundMs        total ms observed at +1
//   maxWoundMs     longest UNBROKEN run at +1 — the SENSED fuse, to be read against hold.js's modelled one
//   ignites[]      { gap, resolutionMs }   gap when the sign went   → +1
//   unwinds[]      { gap, resolutionMs, woundMs }  gap when it went → −1   ← THE MEASUREMENT
//   goneWhileUp    the mob left the world with the sign still +1
//   goneGap        bot→mob distance at the last reading before it left
//   goneHealth     the mob's last SERVER-reported health, the half that says it did not die of damage
//   goneAt         when it left, so a reader can ask whether the bot bled at the same instant
// }
let _mobs = new Map();

function state(mobId) {
  let st = _mobs.get(mobId);
  if (!st) {
    st = { dir: null, since: 0, lastAt: 0, reads: 0, unread: 0, woundMs: 0, maxWoundMs: 0,
           ignites: [], unwinds: [], goneWhileUp: false, goneGap: null,
           goneHealth: null, goneAt: null, lastHealth: null };
    _mobs.set(mobId, st);
  }
  return st;
}

// sample(bot, mobId, entity, gap) — call on every pass, for every live mob. Non-creepers never resolve a
// `swell_dir` key and fall out as unread, so the caller does not filter by species (Law 16: one place
// knows which mobs have fuses).
//
// `gap` is the bot→mob distance this pass, taken from the value the loop already computed and stored
// against the transition, since the transition is the only moment it means anything.
function sample(bot, mobId, entity, gap) {
  const st = state(mobId);
  const now = runClock();
  const dir = swellDir(bot, entity);
  // The poll interval this reading closes, carried onto the transition: the sign flipped somewhere
  // inside this window, and a creeper under knockback covers real ground in it, so the resolution bounds
  // how precise the distance is (Law 25).
  const resolutionMs = st.lastAt ? now - st.lastAt : 0;
  st.lastAt = now;
  // Health is carried on EVERY pass, including unreadable ones, because it is not part of the swell
  // measurement — it is the other half of the vanish verdict below, and a mob whose `swell_dir` went
  // unread on its final pass is exactly the case that verdict must still cover.
  //
  // `livingHealth`, NOT `entity.health`: mineflayer does not surface mob health as a plain field, it
  // arrives as synched entity data and `archer_calculator` owns the decode (the same registry-index
  // pattern `swellDir` above uses). Reading the absent property returns undefined on every pass, which
  // would print "hp unknown" while the strike rows beside it carry health perfectly well (Law 16 — one
  // capability, one route; a second route here would be a silent null).
  const hp = livingHealth(bot, entity);
  if (typeof hp === 'number') st.lastHealth = hp;

  if (dir === null) { st.unread++; return; }
  st.reads++;

  if (st.dir === null) {                        // first readable pass — a baseline, never a transition
    st.dir = dir;
    st.since = now;
    return;
  }
  if (dir === st.dir) {
    if (dir === UP) {
      const run = now - st.since;
      if (run > st.maxWoundMs) st.maxWoundMs = run;
    }
    return;
  }

  const held = now - st.since;
  if (st.dir === UP) {
    st.woundMs += held;
    if (held > st.maxWoundMs) st.maxWoundMs = held;
    st.unwinds.push({ gap: round2(gap), resolutionMs, woundMs: Math.round(held) });
  } else {
    st.ignites.push({ gap: round2(gap), resolutionMs });
  }
  st.dir = dir;
  st.since = now;
}

// vanished(mobId, lastGap) — the mob left the world.
//
// A creeper that vanishes while swelling has not necessarily detonated: a bot that kills a creeper
// mid-swell produces the identical signature, entity gone with the last sign +1. The two are told apart
// by pairing this with whether the bot took blast damage, so the field name states only what was
// observed (`gone while winding up`) and the verdict is left to the reader holding both halves (Law 25).
//
// Every swing this fleet lands on a creeper happens inside BOT_STRIKE_REACH (3.0 b), the same distance as
// the ignite boundary, so a creeper killed by this bot is always killed mid-swell — the ambiguous
// signature is the norm.
//
// `goneHealth` is the server's last health for this mob; the killing blow's health packet may never
// arrive before the entity is removed, so a genuine kill can read as a few hp left, which is why it
// travels with `goneAt`. The timestamp lets a reader ask whether the bot bled at the same instant — a
// detonation close enough to kill the creeper's own body is close enough to be felt, and a sword is not.
// The lens owns that join (`combat_lens.fuseFromRows`), since pairing two records is a reducer's job and
// this file records one thing.
function vanished(mobId, lastGap, lastHealth) {
  const st = _mobs.get(mobId);
  if (!st) return;
  if (typeof lastHealth === 'number') st.lastHealth = lastHealth;
  if (st.dir === UP) {
    st.goneWhileUp = true;
    st.goneGap = round2(lastGap);
    st.goneHealth = typeof st.lastHealth === 'number' ? Math.round(st.lastHealth * 10) / 10 : null;
    st.goneAt = runClock();
    const held = st.since ? runClock() - st.since : 0;
    st.woundMs += held;
    if (held > st.maxWoundMs) st.maxWoundMs = held;
  }
  st.dir = null;
  st.since = 0;
}

function round2(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function band(values) {
  const xs = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!xs.length) return null;
  const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
  const median = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  return { n: xs.length, mean: round2(mean), median: round2(median), min: xs[0], max: xs[xs.length - 1] };
}

// summary() → the one line, or null when there is nothing to say. Returns the text instead of printing
// it, so the caller decides whether and where it appears (Invariant D).
//
// The unwind band leads the line, with the measured and modelled constants named beside it, so the line
// is legible to a reader who does not have this file open (Law 24).
function summary() {
  const all = [..._mobs.values()];
  const readable = all.filter((s) => s.reads > 0);
  const unread = all.reduce((a, s) => a + s.unread, 0);
  if (!all.length) return null;
  if (!readable.length) {
    return `🧨 Fuse: NOT ONE readable swell_dir across ${all.length} mob(s) and ${unread} pass(es) — either ` +
      `nothing with a fuse was fought, or the registry no longer names index 'swell_dir' for this ` +
      `version (fuse_meter's decode, not the tactic).`;
  }
  const unwinds = readable.flatMap((s) => s.unwinds);
  const ignites = readable.flatMap((s) => s.ignites);
  const ub = band(unwinds.map((u) => u.gap));
  const ib = band(ignites.map((i) => i.gap));
  const maxWound = Math.max(0, ...readable.map((s) => s.maxWoundMs));
  const worstRes = Math.max(0, ...unwinds.map((u) => u.resolutionMs), ...ignites.map((i) => i.resolutionMs));
  const goneUp = readable.filter((s) => s.goneWhileUp);

  const parts = [];
  parts.push(ub
    ? `UNWIND (swell_dir → −1) at ${ub.median}b median, range ${ub.min}–${ub.max}b over ${ub.n} — ` +
      `CreeperSwellGoal says ${SWELL_RESET_DISTANCE.toFixed(1)}b`
    : `UNWIND never observed — the sign was never seen to fall`);
  parts.push(ib
    ? `IGNITE (→ +1) at ${ib.median}b median, range ${ib.min}–${ib.max}b over ${ib.n} (model 3.0b)`
    : `IGNITE never observed`);
  parts.push(`longest unbroken swell ${Math.round(maxWound)}ms`);
  if (goneUp.length) {
    parts.push(`${goneUp.length} mob(s) LEFT THE WORLD still winding up, last seen at ` +
      `${goneUp.map((s) => `${s.goneGap}b @ ${s.goneHealth == null ? '?' : s.goneHealth}hp`).join('/')} — ` +
      `a detonation and a mid-swell kill look identical here; the lens joins these against the bot's own ` +
      `damage rows by timestamp and states which`);
  }
  return `🧨 Fuse MEASURED off swell_dir: ${parts.join('; ')}. ` +
    `${readable.length} mob(s) readable, ${unread} unread pass(es)` +
    `${worstRes ? `, worst poll gap ${worstRes}ms (a shove crosses real ground in that — the gaps above ` +
      `are bounded by it, not exact)` : ''}.`;
}

function reset() {
  _mobs = new Map();
}

// Read-only view of state, as numbers, for tests and other structured readers.
function stats() {
  return {
    mobs: [..._mobs.entries()].map(([mob, s]) => Object.assign({ mob }, s)),
  };
}

module.exports = { swellDir, sample, vanished, summary, reset, stats, UP, DOWN, SWELL_RESET_DISTANCE, SWELL_TO_BLAST_MS };
