'use strict';
// fuse_meter — the creeper's OWN fuse state, read off the server instead of modelled.
//
// Swell is an actual server-synched state, VERIFIED against the installed stack rather than assumed
// (Law 23): minecraft-data names the creeper's synched entity data as
//
//     [… mob_flags, swell_dir, is_powered, is_ignited]
//
// so `swell_dir` is a real, named, SERVER-SYNCHED field that arrives in `entity_metadata` and that
// mineflayer merges into `entity.metadata` by index. The bot can watch it. Nothing here is inferred
// from damage numbers, which is what every creeper reading in this fleet has been until now.
//
// ── WHAT IS SYNCHED IS THE DIRECTION, NOT THE COUNTER — and that is the more useful half ────────────
// Java syncs `swellDir` (−1 or +1), never the `swell` int itself; the vanilla CLIENT reconstructs the
// counter by integrating that sign each tick. So a successor looking for a "fuse: 17/30" field will not
// find one and must not conclude the state is unreadable.
//
// The direction is what the open question actually needs. `CreeperSwellGoal` is asymmetric — it IGNITES
// on `distanceToSqr < 9` (3.0 b) but only sets `swellDir = -1` on `distanceToSqr > 49` (7.0 b) or a
// broken line of sight. **The gap at the moment the sign flips to −1 IS the boundary**, so this meter
// answers by measurement a question inference alone could not settle. The constant lives below, in
// this file, because this is the module that owns the swell; the reconstructed fuse clock below is a
// by-product of that measurement.
//
// ── THE INVISIBILITY RULE, AND WHAT IT COST TO LEARN ───────────────────────────────────────────────
// battle_stations owns the voice — this module has no watcher of its own (Invariant D) — and the reading
// is taken from passes the arm was going to run anyway, so it costs the tactic nothing. That rule is not caution — a meter that sleeps to take its own measurement spends real
// distance of a creeper's escape per reading, and can cost a live wave its hold distance over it. A fuse
// instrument that costs fuse is the one thing this file may never become.
//
// The metadata INDEX is resolved from the live registry rather than hardcoded to 16, for the reason
// `archer_calculator.bowDrawState` gives at length: the index is a per-version, per-entity fact
// mineflayer already carries, and a literal would go silently wrong on the next protocol bump — wrong in
// the direction that reads as "the creeper never swelled", which is indistinguishable from good news.
// That decode is duplicated in shape here rather than shared because `archer_calculator` is about
// archers; a successor should read this as the established pattern, not as a new one.

// ── THREE STATES AND NOT A BOOLEAN, for bowDrawState's exact reason ────────────────────────────────
// An unreadable metadata array is not the same fact as "not swelling", and collapsing them makes a
// sensing failure look identical to a calm creeper — the run would report a perfect record of fuses that
// never lit (Law 25: "could not tell" is one of the answers, and it is the one that indicts the
// instrument instead of exonerating the tactic). Unread passes are counted and reported.
//
// UNDEFINED IS NOT −1, even though −1 is the vanilla default. 1.21.5 sends synched data only for fields
// that differ from their default, so a creeper that has never swelled carries NO index 16 at all. Reading
// that absence as "winding down" would be a claim about the world derived from the protocol's silence,
// and it would manufacture a −1 → +1 "ignition" out of the first packet that ever arrives.
const { livingHealth } = require('@utils/calculators/archer_calculator');
// ── THE RUN CLOCK, NOT THE WALL CLOCK ──────────────────────────────────────────────────────────────
// Every timestamp this meter produces is a millisecond offset from when the process started, never an
// epoch. It was `combat_runClock()` until that record was deleted (2026-08-22) and the reason it was
// exported holds without it: a bench or a reader that takes a relative number for an absolute one is off
// by ~1.8e12 ms, and that is a silent mis-read rather than a loud failure — the number still looks like
// a time. Keeping ONE clock in this file means no line has to be checked for which kind it used.
//
// Module load IS process start for anything that measures, so there is no arming step to forget: a
// baseline set at first use would make the first fuse of a run read as time zero.
const BOOT = Date.now();
const runClock = () => Date.now() - BOOT;

const UP = 1;
const DOWN = -1;

// ── THE ONE SURVIVING CREEPER CONSTANT IN THE FLEET ─────────────────────────────────────────────────
// Where Java's CreeperSwellGoal actually flips the sign back to −1: `distanceToSqr > 49`, so 7.0 b. Every
// other movement-based creeper model (a fuse clock, an ignite boundary, an escape-angle cone, a
// hits-per-fuse model) was deleted; this number is the only piece that was never a movement model.
//
// IT LIVES HERE BECAUSE THIS MODULE OWNS THE SWELL. The meter measures where the sign flips; the
// constant is what the measurement is graded against. Keeping them apart is what let the fleet carry two
// contradicting values — a modelled 3.0 and a source-read 7.0 — with nothing to reconcile them.
//
// It drives NO behaviour, and it must not start: the shield answers the swell now, and a distance gate
// beside it would be a second opinion about the same fact. Its only consumer was the `fuse` row
// battle_stations stamped it into (Law 23 — the claim stored beside its check), so with that record
// deleted it is read by the meter's own reporting and nothing else.
const SWELL_RESET_DISTANCE = 7.0;

// ── HOW LONG A SWELL LASTS, AND WHY THIS NUMBER IS WEAKER THAN THE ONE ABOVE ───────────────────────
// Java's Creeper sets `maxSwell = 30` ticks and detonates when the counter reaches it, so an unbroken
// swell is 1500 ms. THIS IS READ FROM THE SOURCE, NOT MEASURED HERE, and the distinction matters because
// SWELL_RESET_DISTANCE above WAS measured and this fleet has been burned by treating the two kinds of
// number alike.
//
// `maxWoundMs`, this file's own measured record, is expected to sit BELOW this constant rather than
// contradict it — every swell that gets interrupted (the creeper dying, or the bot leaving the ignite
// radius) is timed short of a full run, and a swell that ran to term detonated, so the bot does not get
// to time that one.
//
// It exists because the shield needs a DEADLINE to count back from (gunner.shieldOrder). If a run ever
// records a `maxWoundMs` above this, that is the number being wrong and it is loud — a fuse longer than
// its own maximum is a form error, not a tuning miss.
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

// sample(bot, mobId, entity, gap) — call on every pass, for every live mob. Non-creepers simply never
// resolve a `swell_dir` key and fall out as unread, so the caller does not have to filter by species
// (and must not: a filter on `entity.name` in the caller is a second place that knows which mobs have
// fuses, which is the Law 16 shape this fleet keeps deleting).
//
// `gap` is the bot→mob distance THIS pass, taken from the value the loop already computed. It is stored
// against the transition rather than re-derived, because the transition is the only moment it means
// anything and a distance re-read later is a different number.
function sample(bot, mobId, entity, gap) {
  const st = state(mobId);
  const now = runClock();
  const dir = swellDir(bot, entity);
  // The poll interval this reading closes. Carried onto the transition because it BOUNDS the distance's
  // truth: the sign flipped somewhere inside this window, and a creeper under knockback covers real ground
  // in it. A reader must be able to see the resolution rather than trust the decimal (Law 25).
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
// A CREEPER THAT VANISHES WHILE SWELLING HAS NOT NECESSARILY DETONATED, and this file will not say that it
// has. A bot that kills a creeper mid-swell produces the identical signature: entity gone, last sign +1.
// The two are told apart by pairing this with whether the bot took blast damage, which battle_stations and
// the damage lens already record — so the honest field name is what was observed (`gone while winding up`)
// and the verdict is left to the reader who has both halves (Law 25: state the true result, not the
// convenient one).
//
// ── WHY "MID-SWELL KILL" IS THE EXPECTED CASE, NOT THE EXOTIC ONE ───────────────────────────────────
// Worth stating because the ambiguity above reads as if the two were equally likely, and they are not.
// Every swing this fleet lands on a creeper happens inside BOT_STRIKE_REACH (3.0 b), which is the SAME
// number as the ignite boundary — so the fuse is running for every hit the bot ever throws, including
// the killing one. A creeper killed by this bot is ALWAYS killed mid-swell. The signature is the norm.
//
// ── THE TWO FIELDS THAT DECIDE IT ──────────────────────────────────────────────────────────────────
// `goneHealth` is the server's last health for this mob. It cannot be conclusive alone — the killing
// blow's health packet may never arrive before the entity is removed, so a genuine kill can read as
// "vanished with 5 hp left" — which is why it travels WITH `goneAt` rather than instead of it. The
// timestamp is what lets a reader ask the only question that separates the two cleanly: did the BOT
// bleed at that same instant? A detonation close enough to kill a creeper's own body is close enough
// to be felt; a sword is not. The lens owns that join (`combat_lens.fuseFromRows`), because pairing two
// records is a reducer's job and this file records one thing.
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

// summary() → the one line, or null when there is nothing to say. Returns rather than logs (Invariant D).
//
// THE UNWIND BAND LEADS, because it is the number the whole instrument was built to get and the one the
// two rival models disagree about. The two constants travel beside it named, so the line is legible to a
// reader who does not already know the dispute — a summary that printed "unwind at 5.1b" without saying
// what 5.1 refutes would need this file open to be worth anything (Law 24).
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

// ── calibration() IS GONE (2026-08-22), AND WHAT IT FED WENT FIRST ─────────────────────────────────
// It returned one structured row per readable mob — every unwind and ignite gap, the wound clock, the
// unread count — and battle_stations banked those rows into `fleet_logs/combat_journal/` so a boundary
// could be established from the SPREAD of many fights rather than voted on by one. That record was
// deleted, so the rows had nowhere to go and the function had no caller.
//
// The measurement itself is unaffected: `summary()` still states this fight's crossings, and it is the
// half a reader acts on. What is retired is the cross-run population — a boundary re-derived from many
// fights is no longer available, and SWELL_RESET_DISTANCE stands on its source read alone.

function reset() {
  _mobs = new Map();
}

// Read-only view for the tests and for anything that wants numbers rather than a sentence.
function stats() {
  return {
    mobs: [..._mobs.entries()].map(([mob, s]) => Object.assign({ mob }, s)),
  };
}

module.exports = { swellDir, sample, vanished, summary, reset, stats, UP, DOWN, SWELL_RESET_DISTANCE, SWELL_TO_BLAST_MS };
