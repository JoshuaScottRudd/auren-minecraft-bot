// module: tools/lanista_shared — the arena bench's ONE bootstrap, its requires, and its config.
//
// WHY IT IS A SEPARATE FILE FROM lanista.js: every @-aliased require (`@utils/*`, `@thinking/*`) needs
// NODE_PATH extended before it resolves. Requiring this module first is what guarantees that order — a
// module reaching for `vec3` or `@utils/*` directly would load fine from the trunk and crash when
// required in any other order. So nothing else requires them; they come through here.
//
// It decides nothing. Config lives here so the bench is re-tuned in one place (Law 16).

'use strict';

// Before the scout require, not after — the @-aliases and mineflayer both resolve off it. The call is
// idempotent, so the scout booting it again costs nothing.
const paths = require('../workshop_paths');
paths.bootstrapModules();

const rconLink = require(paths.bot('js_kernel/utils/rcon_link'));
const arena = require('./arena_sites');
// The construct's OWN pathfinder, imported rather than transcribed. Reachability is not being TESTED
// here — it is a siting criterion, and the only correct definition of "can this body get there" is the
// one the body's own locomotion uses. A transcription would be a second pathfinder free to disagree with
// the first (Law 16), and the disagreement would show up as mobs the bot can never reach. Safe from
// outside the construct: pathfinding_utils is a pure graph algorithm with no watcher and no signal bus,
// so a search run here writes nothing into the construct's trace (Law 26).
const pathfinding = require('@utils/pathfinding_utils');
const { createScout } = require('../camera/camera_scout');
// The construct's own aggro threshold, read rather than restated: a bench carrying its own copy would
// drift from the bot's and would then place mobs at a range the bot does not consider a fight.
//
// BOTH are imported, and `aggroRangeFor` is the one that must be used on any per-mob question: the flat
// AGGRO_RANGE is 15 but the skeleton family is honoured at 16 in architect_config's own per-species table,
// which names itself THE ONE ROUTE and flags a second copy of the flat value anywhere on that path as the
// regression to watch. Gating a summon on the flat 15 alone refuses mobs the bot's own per-species range
// would in fact have seen and could reach — the refusal would be the bench's arithmetic, not the bot's.
const { AGGRO_RANGE, AGGRO_VERTICAL_RANGE, aggroRangeFor } = require('@thinking/architect_config');

// ── Configuration ───────────────────────────────────────────────────────────────────────────────────

// One tag on every mob the bench summons, which is what makes `--cleanup` a single command and what
// lets the fight loop count "the field" without confusing it with the world's own spawns.
const ARENA_TAG = 'auren_arena';
const SCOUT_NAME = 'Lanista_Scout';

// Where an opponent may stand. These are the dials the siting work settled on, and they are a SINGLE
// definition rather than one for surveying and one for fighting (Law 16).
const SITING = {
  blueprint: 'spawn_box',
  flatness: 'stepwise',
  reachGate: true,          // a mob that cannot WALK to the bot is not an opponent, it is scenery
  requireSightline: true,   // ...and one that cannot SEE it will not start (threat_scanner's own gate)
  // ── THE GROUND THE FIGHT IS FOUGHT ON: an open area, no water ──────────────────────────────────────
  //
  // A dial `arena_sites` honours only because it is declared here; terrain is a label everywhere else.
  // Every number is a measured confound rather than a taste:
  //
  //   maxWaterPct 5   — a beach anchor sited over water lets a mob take fall/drown damage it never took
  //                     from the bot, so the trial measures the terrain instead of the fight. 5 rather
  //                     than 0 because a single pond cell some distance away is scenery, not a hazard,
  //                     and 0 would refuse most of a plains world.
  //   maxRelief 6     — fall damage starts at 4 blocks, so anything a body can walk off for damage is
  //                     the confound; 6 leaves normal rolling ground.
  //   maxCanopyPct 20 — carried over from what the `open` biome group was already for: dense canopy
  //                     blocks sightlines and interrupts ranged casts, which is terrain answering a
  //                     question that was asked of the tactic.
  //
  // A refused anchor ADVANCES the sweep (arena_sites' cycle rule), so this narrows where a fight is
  // sited and never whether one happens. If every anchor in a world fails it, the shortfall line says so
  // by name rather than reporting an empty world.
  ground: { maxWaterPct: 5, maxRelief: 6, maxCanopyPct: 20 },
};

// The world the fight happens in. Daytime burns zombies and skeletons outright — with no daylight-cycle
// lock the sun can end a fight for a reason that has nothing to do with combat, and a bench that does
// not pin time-of-day can read an opponent burning to death as a win it did not test for (Law 25: a
// criterion nobody met must not report as met).
//
// `difficulty` is the same reason one step out: on peaceful the server deletes hostiles outright, so a
// bench that does not state it can measure a fight that was never possible.
const WORLD = {
  time: 'midnight',        // zombies and skeletons do not burn; the fight ends because someone won it
  daylightCycle: false,    // ...and it STAYS midnight, so round 5 is fought in the same world as round 1
  weather: 'clear',        // rain also stops burning — authored so it is never the accidental reason
  difficulty: 'hard',      // mobs must be able to exist and to hit back
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = p => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;
const round2 = n => Math.round(n * 100) / 100;
function log(stage, msg) { console.log(`[${stage.toUpperCase()}] ${msg}`); }

module.exports = {
  rconLink, arena, pathfinding, createScout,
  ARENA_TAG, SCOUT_NAME, SITING, WORLD, AGGRO_RANGE, AGGRO_VERTICAL_RANGE, aggroRangeFor,
  sleep, fmt, round2, log,
};
