// perception node: health_integrity
// purpose: The self-preservation counterpart to building_integrity / farming_integrity / torch_integrity —
//          ONE node that reads the bot's OWN vital internals and hands the brain a single verdict. Today it
//          covers HUNGER (food) and HEALTH (hp); it is named 'health', not 'hunger', because it is the
//          expansion point for every self-state check to come (armor, potion effects, drowning, fall
//          exposure). For now: hunger and health only. assessors/hunger gates the `eat`
//          job on needs_to_eat; the health read rides along for inspectability and future action.
//
// WHY it logs its state EVERY scan: building/mining/farming integrity each print a
// full status line every time they are scanned — that heartbeat is how the watcher SHOWS what each
// subsystem senses. Hunger used to dedup its log (print only on a food-state transition), so on a steady
// food level it went silent and the health subsystem was invisible in the stream. Now it prints one health
// line per scan, exactly like its siblings, so "health integrity" reads in the trace beside building and
// farming. Re-sensing every sweep is also the verification that closes the eat loop (Invariant B): after a
// bot eats, the next sweep reads fresh food; full → no job posts; still low → re-posts.
//
// DORMANT ON PEACEFUL for ACTION: bot.food never drains with no hunger mechanic, so needs_to_eat stays
// false and no eat job ever posts — but the heartbeat still prints (food 20/20 · healthy), so the subsystem
// is visible even when idle, same as a fully-built structure still logging its all-correct status.
//
// Pure observation (Law 1 perception exception — action fragments may call this directly). Reads only the
// bot's own faculties (bot.food/bot.health), so it needs no located base and never throws pre-home.

'use strict';

const watcher = require('@kernel/watcher');
const { HUNGER_EAT_THRESHOLD, HUNGER_MUST_EAT_THRESHOLD, HUNGER_FULL } = require('@thinking/architect_config');

const TAG = 'health_integrity';

// Minecraft: natural health regen requires food ≥ 18 (and stops below). The eat threshold sits AT 18 so a
// bot that eats on time never loses regen — reporting it makes the "why 18" legible in the trace.
const REGEN_FLOOR = 18;

let _lastScan = null;

// scan(bot) → the health verdict. Fields the brain reads:
//   food            current food points (0–20)
//   health          current health / hp (0–20), or null if unreadable
//   needs_to_eat    food ≤ HUNGER_EAT_THRESHOLD (SHOULD-EAT: try to eat, keeps regen alive; non-fatal)
//   must_eat        food ≤ HUNGER_MUST_EAT_THRESHOLD (MUST-EAT floor: eat_executor's Law 13 halt fires here)
//   full            food ≥ HUNGER_FULL (nothing to do)
//   deficit         HUNGER_FULL − food (how much a full eat must restore)
//   regen_ok        food ≥ REGEN_FLOOR (health can regenerate)
function scan(bot) {
  if (!bot || typeof bot.food !== 'number') {
    throw new Error('[health_integrity] CODING VIOLATION: bot.food must be a number before scan(). Check caller.');
  }
  const food = bot.food;
  const health = typeof bot.health === 'number' ? bot.health : null;
  const needsToEat = food <= HUNGER_EAT_THRESHOLD;
  const mustEat = food <= HUNGER_MUST_EAT_THRESHOLD;

  const verdict = {
    schema: 'auren.health_integrity.v1',
    generated_at: new Date().toISOString(),
    food,
    health,
    needs_to_eat: needsToEat,
    must_eat: mustEat,
    full: food >= HUNGER_FULL,
    deficit: Math.max(0, HUNGER_FULL - food),
    threshold: HUNGER_EAT_THRESHOLD,
    must_threshold: HUNGER_MUST_EAT_THRESHOLD,
    regen_ok: food >= REGEN_FLOOR,
  };
  _lastScan = verdict;
  _log(verdict);
  return verdict;
}

// One health heartbeat per scan (Law 5), same as building/farming integrity — keeps the
// subsystem visible in the trace, not only on a state change. Concise: food, hp, regen state, and the one
// actionable verdict (eat due / full / ok).
function _log(v) {
  const hp = v.health != null ? `${v.health}/20` : 'n/a';
  const regen = v.regen_ok ? 'regen alive' : `regen STALLED (food<${REGEN_FLOOR})`;
  const state = v.must_eat
    ? `STARVING (≤${v.must_threshold}) → MUST eat, Law 13 halt if no food (Law 17)`
    : (v.needs_to_eat
        ? `HUNGRY (≤${v.threshold}) → should eat (non-fatal; works on if unfed)`
        : (v.full ? 'full' : `ok (above ${v.threshold} eat line)`));
  watcher.summary(TAG, `food ${v.food}/20 · hp ${hp} · ${regen} · ${state}`);
}

function getState() { return _lastScan; }

module.exports = { scan, getState };
