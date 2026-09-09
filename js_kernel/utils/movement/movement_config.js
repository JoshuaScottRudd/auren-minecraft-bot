// module: movement/movement_config — the tunable dials for the movement family, in one place.
// Nothing here decides anything; it holds the numbers the primitives read, so a re-tune is one edit
// and cannot land in two files at different values (Law 16).
//
// The scaffold/structural inversion is the non-obvious part: pillars and bridges are THROWAWAY and sit
// on the open path, so they read the scaffold order (cheapest-to-replace first: soil, sediment, then
// crafted goods); permanent fill reads structural_fill (cobblestone first). Same members, opposite
// priority, one definition each — re-tune the ORDER in fragment_utils, never here.

'use strict';

const { group_to_item } = require('@utils/fragment_utils');


// ── SECTION 3: Configuration Objects ──
const movementConfig = {
  faceDuration: 150,
  forwardDuration: 250,
  tapDuration: 100,
  postMoveDelay: 100,
  jumpPauseDuration: 150,
  jumpTapDuration: 400,
};

const escalationConfig = {
  enabled: true,
  maxEscalationAttempts: 1,
  tapAttemptsBeforeEscalation: 2,
  pulseDuration: 150
};

function setMovementConfig(partial) { Object.assign(movementConfig, partial || {}); }
function setEscalationConfig(partial) { Object.assign(escalationConfig, partial || {}); }
function getMovementConfig() { return movementConfig; }
function getEscalationConfig() { return escalationConfig; }

// defaultPriority: derived from the canonical throwaway order so there's one source of truth
// (Law 16) — re-tune the order in fragment_utils, not here.
//
// pillar_block, NOT scaffold_block, and NOT structural_fill. Two separations, each load-bearing:
//   · vs structural_fill — scaffolding is throwaway and on the open path (spend the cheapest first);
//     fill is permanent (spend the most durable first). Same members, inverted priority.
//   · vs scaffold_block — gravel and sand are legal PILLAR blocks and illegal BRIDGE blocks, because a
//     pillar block lands supported and a bridge block lands over air (Law 17). BRIDGE_PREFS below is
//     the filtered exposure of the same order; the two must not be collapsed back into one read.
const pillarConfig = {
  jumpHoldMs: 350,
  postJumpSettleMs: 100,
  debug: false,
  defaultPriority: [...group_to_item.pillar_block]
};

// Bridging lays the same throwaway material as pillaring in the same order, MINUS the gravity blocks a
// bridge cannot carry (see pillarConfig above). This was declared as an identical literal inside BOTH
// tryBridgeStep and stepHorizontal — two copies in one file, either of which could be re-tuned without
// the other (Law 16).
//
// NO `|| [fallback]` ON EITHER READ. Both groups are module constants in this repo, so an absent one is
// a coding violation, not an environmental failure — and the literal that used to stand here silently
// substituted a DIFFERENT preference order (cobblestone and stone, the two blocks the throwaway order
// deliberately ranks last) for the real one, on a boot nobody would have been told about (Law 13: never
// default a missing field; Law 16: no fallback that silently does the primary's job).
const BRIDGE_PREFS = [...group_to_item.scaffold_block];

function setPillarConfig(partial) { if (partial && typeof partial === 'object') Object.assign(pillarConfig, partial); }
function getPillarConfig() { return pillarConfig; }

module.exports = {
  movementConfig,
  escalationConfig,
  setMovementConfig,
  setEscalationConfig,
  getMovementConfig,
  getEscalationConfig,
  pillarConfig,
  BRIDGE_PREFS,
  setPillarConfig,
  getPillarConfig,
};
