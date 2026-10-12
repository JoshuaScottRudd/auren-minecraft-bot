// module: crew_board
// purpose: the tank crew's shared board. Three named sections — commander, gunner, driver — each with
//          exactly one writer, read by anyone (Law 6: transparent state, one named owner per section).
//          Monster data is derived nowhere but the commander section, which owns it exclusively; readers
//          may act on what a section holds but never alter it.
//
// In memory, not on disk (Law 9): every field is re-derived from scratch each tick, so nothing on this
// board needs to survive a restart. The board is rewritten every 50 ms, so a periodic snapshot would
// describe only a random frame; the inspection surface is the `read*()` functions below plus the
// commander's own watcher line, both taken at the instant they describe (Law 26).
//
// No write function is exported. A section's pen is handed out exactly once by `claimPen`, which throws
// on a second claim for the same section (Law 13), so a second writer is a boot failure with the
// offender's name on it, not a rule anyone has to remember.

'use strict';

// ---------------------------------------------------------------------------
// SECTION 1: The board
// ---------------------------------------------------------------------------
// Module-level: one crew per process. Every section starts EMPTY, so a consumer that runs before its
// owner's first sweep sees `null` and can say so, instead of acting on a value that reads like "no
// monsters" (Law 13 — never default a missing field).

const SECTIONS = ['commander', 'gunner', 'driver'];

// Every field this board carries, enumerated here so a reader does not need to find the writer to learn
// the shape.
function _blankCommander() {
  return {
    sweptAt: null,        // ms (Date.now) of the sweep that produced this section, or null before the first
    hostiles: [],         // EVERY hostile loaded this sweep, nearest first, each carrying its aggro verdict
    active: [],           // the subset that passed the aggro test — the threats, nearest first
    tracked: 0,           // hostiles seen this sweep, including the ones that failed the aggro test
    closest: null,        // the nearest ACTIVE hostile descriptor — the WORLD's answer, for reports
    // `focus` is what the gunner swings at and the driver closes on when nothing is threatening — null
    // whenever any active mob is drawing or swelling, the honest answer to "what is safe to hit" on those
    // ticks (Law 13: no fallback value restoring the offensive stance).
    //
    // It is not the facing: the gunner points at the live threat, guard up or not, and falls back to
    // `focus` only when nothing threatens, so `focus` and the gunner's `face` event usually disagree
    // during a defensive fight.
    focus: null,
    nearest: null,        // the nearest hostile of ANY aggro state — for reports that ask "what is around"
    engage: null,         // the descriptor the commander says to OPEN a fight with, or null
    engageReason: null,   // 'in_base_seek' | 'aggro' | null
    swelling: [],         // ids of creepers whose server-synched swell direction is UP
    // Shaped like `swelling`: both are id lists decoded from server-synced metadata by the commander, the
    // one seat that decodes monster data, so a reader that handles one handles the other. `notching` is
    // every hostile the server says is USING AN ITEM (bit 0 of living_entity_flags), which for a skeleton
    // is a drawn bow.
    notching: [],         // ids of hostiles whose item-use flag is set — a skeleton with an arrow on the string
  };
}

function _blankGunner() {
  return {
    heldYaw: null, targetId: null, lastSwingAt: null, swings: 0,
    // The gunner raises and lowers the shield; the driver has to know, because a vanilla client cannot
    // sprint and block at the same time, and the exclusion must be HELD every tick by the seat that owns
    // sprint (Law 19). It travels through this board, never as a call between seats (Law 1).
    shield: false,        // is the shield COMMANDED up right now
    shieldWhy: null,      // 'notched_arrow' | 'swell' | 'settling' | null — why, for the record (Law 6)
    shieldAgainst: null,  // entity id the shield is facing; a shield blocks only what it faces

    // Digging and placing need a facing, and the driver may never write yaw, so the work moves to the
    // seat that already holds the heading (Invariant D). This is the answer to the driver's
    // terrainRequest below, published the same way the shield is — never called across (Law 1).
    //
    // Four states; `refused` is not a flavour of `working` — they demand opposite driver behaviour.
    //   refused — a mob is inside strike reach. The yaw is spoken for and the gunner will not yield it.
    //   working — accepted; in flight, or holding for a swing window.
    //   done    — the gunner believes the world changed. A claim, not a fact (Law 23): the driver
    //             re-senses the cell before acting on it.
    //   failed  — attempted and could not (no material, out of reach, refused by dig authority).
    terrainStatus: null,  // null | { kind, at:{x,y,z}, state, why }
  };
}

function _blankDriver() {
  return {
    keys: null, standingOrder: null, targetId: null,

    // A standing want, re-published every tick, never a queued message: the driver re-states it every
    // tick it still holds, and silence is the withdrawal (Invariant B — never act on what was
    // remembered). The gunner holds no request of its own, only a dig already in flight, dropped the
    // moment the want stops appearing.
    //
    // `at` is a block cell, never a route: the ask is per-step, since the seat making it is a per-tick
    // step chooser, not a planner.
    terrainRequest: null,  // null | { kind: 'dig' | 'place', at:{x,y,z}, why }
  };
}

const _board = {
  commander: _blankCommander(),
  gunner: _blankGunner(),
  driver: _blankDriver(),
};

const _pens = new Set();

// ---------------------------------------------------------------------------
// SECTION 2: The pen (write side)
// ---------------------------------------------------------------------------

// claimPen(section) → a write function, once. Called at module scope by the seat that owns the section.
//
// The returned function replaces the section wholesale: a partial write would leave untouched fields
// describing an earlier instant, so one section would carry two timestamps' worth of truth (Invariant
// B). Every seat rebuilds its whole section from fresh state each tick.
function claimPen(section) {
  if (!SECTIONS.includes(section)) {
    throw new Error(`[crew_board] "${section}" is not a section of this board (${SECTIONS.join(', ')}). ` +
      `Sections are declared here, not created by their writers — a seat that needs a new one is a design ` +
      `change and belongs at the Architect's table (Law 16).`);
  }
  if (_pens.has(section)) {
    throw new Error(`[crew_board] the "${section}" pen is already held. One writer per section, forever ` +
      `(Law 6 / Invariant D). A second module reaching for this pen is the blackboard-rots-into-a-global ` +
      `failure, caught at load instead of in a trace.`);
  }
  _pens.add(section);
  return function write(next) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`[crew_board] the ${section} section must be written as an object; got ${typeof next}.`);
    }
    // Frozen at the section and at the one array a reader could realistically push to. The descriptors
    // inside `active` are left thawed: they are rebuilt from scratch every sweep, so a reader that
    // mutated one would only corrupt a copy already discarded 50 ms later.
    for (const k of ['hostiles', 'active', 'swelling', 'notching']) {
      if (Array.isArray(next[k])) Object.freeze(next[k]);
    }
    _board[section] = Object.freeze(next);
  };
}

// ---------------------------------------------------------------------------
// SECTION 3: The read side — free to everyone, and the only thing exported broadly
// ---------------------------------------------------------------------------

// readCommander() → the commander's section, frozen. Never null: before the first sweep it is the blank
// shape, whose `sweptAt: null` says "nobody has looked yet" — distinct from "looked and found nothing"
// (`sweptAt` set, `active` empty), a different fact a caller acts on differently (Law 25).
function readCommander() { return _board.commander; }
function readGunner() { return _board.gunner; }
function readDriver() { return _board.driver; }

// reset() — wipe every section back to blank without releasing the pens (Law 8): pens are
// process-lifetime, claimed once at load and held until the process ends; the contents are
// per-engagement.
function reset() {
  _board.commander = _blankCommander();
  _board.gunner = _blankGunner();
  _board.driver = _blankDriver();
}

module.exports = {
  claimPen,
  readCommander,
  readGunner,
  readDriver,
  reset,
  SECTIONS,
};
