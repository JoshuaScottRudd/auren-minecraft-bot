// module: tools/lanista_shared — the arena bench's one bootstrap, its requires, and its config.
// Every @-aliased require (`@utils/*`, `@thinking/*`) needs NODE_PATH extended first; requiring this
// module first is what guarantees that order, so nothing else requires them directly. It decides
// nothing — config lives here so the bench is re-tuned in one place (Law 16).

'use strict';

// Before the scout require, not after — the @-aliases and mineflayer both resolve off it. The call is
// idempotent, so the scout booting it again costs nothing.
const paths = require('../workshop_paths');
paths.bootstrapModules();

const rconLink = require(paths.bot('js_kernel/utils/rcon_link'));
const arena = require('./arena_sites');
// The construct's own pathfinder, imported (Law 16): reachability is a siting criterion, and the only
// correct definition of "can this body get there" is the one the body's own locomotion uses. Safe from
// outside the construct: pathfinding_utils is a pure graph algorithm with no watcher and no signal bus,
// so a search run here writes nothing into the construct's trace (Law 26).
const pathfinding = require('@utils/pathfinding_utils');
const { createScout } = require('../camera/camera_scout');
// The construct's own aggro threshold, read here, never restated (Law 16). Both are imported;
// `aggroRangeFor` is the one route for any per-mob question — the flat AGGRO_RANGE is 15, but
// architect_config's per-species table honours some species (the skeleton family: 16) at a different range.
const { AGGRO_RANGE, AGGRO_VERTICAL_RANGE, aggroRangeFor } = require('@thinking/architect_config');

// ── Configuration ───────────────────────────────────────────────────────────────────────────────────

// One tag on every mob the bench summons, which is what makes `--cleanup` a single command and what
// lets the fight loop count "the field" without confusing it with the world's own spawns.
const ARENA_TAG = 'auren_arena';
const SCOUT_NAME = 'Lanista_Scout';

// Where an opponent may stand — a single definition for surveying and fighting alike (Law 16).
const SITING = {
  blueprint: 'spawn_box',
  flatness: 'stepwise',
  reachGate: true,          // a mob that cannot WALK to the bot is not an opponent, it is scenery
  requireSightline: true,   // and one that cannot SEE it will not start (threat_scanner's own gate)
  // ── THE GROUND THE FIGHT IS FOUGHT ON: an open area, no water ──────────────────────────────────────
  // A dial `arena_sites` honours only because it is declared here. Each value guards one confound:
  // water lets a mob take fall/drown damage the bot never dealt; relief (fall damage starts at 4
  // blocks) lets a mob take fall damage walking the ground; canopy blocks sightlines and ranged casts.
  // A refused anchor advances the sweep (arena_sites' cycle rule), narrowing where a fight is sited,
  // never whether one happens.
  ground: { maxWaterPct: 5, maxRelief: 6, maxCanopyPct: 20 },
};

// The world the fight happens in, pinned so nothing but combat can end a fight (Law 25: a criterion
// nobody met must not report as met). Daytime burns zombies and skeletons outright; peaceful deletes
// hostiles outright — either would end a wave for a reason that is not the fight.
const WORLD = {
  time: 'midnight',        // zombies and skeletons do not burn; the fight ends because someone won it
  daylightCycle: false,    // stays fixed, so every round is fought under the same sky
  weather: 'clear',        // rain also stops burning
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
