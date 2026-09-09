// module: crew_board
// purpose: The tank crew's shared board. Three named sections — commander, gunner, driver — each with
//          exactly ONE writer, read by anyone. It is where the crew agrees about the world without
//          talking to each other (Law 6: transparent state, one named owner per section). Monster data
//          is derived nowhere but the commander section, which owns it exclusively — the same one-writer
//          discipline the signal bus uses: readers may act on what a section holds but never alter it.
//
// ── WHY IN MEMORY AND NOT A FILE, THOUGH IT IS SHAPED LIKE corporate_headquarters.json ────────────────
// It IS built like corporate_headquarters — that module owns an on-disk artifact that consumers never
// read from disk after startup. The office/chair discipline is the part that carries over here in full.
// The disk half is deliberately absent, for two reasons a successor should not re-litigate:
//   1. Law 9 — transient state belongs in module-level variables, not JSON. corporate_headquarters holds
//      state that must survive a restart (buildspots, claims, magnets). Nothing on this board may: every
//      field is re-derived from scratch on the next tick, and a board loaded from disk at boot would be
//      a picture of a fight that ended before the process died (Invariant B).
//   2. corporate_headquarters flushes every 2000 ms. This board is rewritten every 50 ms. A 2 s snapshot
//      of a 20 Hz board is not an inspection surface, it is a random frame — and a reader who believed it
//      described the instant would be reading a falsehood no form check can see (Law 26). The inspection
//      surface is the `read*()` functions (below) plus the commander's own watcher line, which are both
//      taken AT the instant they describe.
// If an on-disk artifact is ever wanted, it is one periodic `writeOffice` call away and it belongs to the
// commander, not to this file — this file routes and never decides (Law 3).
//
// ── HOW "READERS CANNOT WRITE" IS ENFORCED — A GUARANTEE, NOT A CONVENTION ──────────────────────────
// No write function is exported. A section's pen is handed out exactly once by `claimPen`, which THROWS
// on a second claim for the same section (Law 13 — and it runs for free on every change, because
// preflight loads every file in the tree and each seat claims its pen at module scope). So a
// second writer is not a rule anyone has to remember: it is a boot failure with the offender's name on it.
//
// This is the same choice that deleted `faceYaw` from `pressHeading` rather than defaulting it — a
// mistake nobody can spell beats a mistake everyone agrees not to make (Law 26: a guarantee beats a
// catch). The wrong turn here is exporting `writeCommander()` "just for the probe"; the probe claims the
// pen like anything else, and if two things want it, that is the Law 16 question surfacing correctly.
//
// ── WHAT IT MUST NEVER BECOME ───────────────────────────────────────────────────────────────────────
// A place a seat writes another seat's field "just this once, because it knew better." That is how a
// blackboard rots into a global, and it rots silently. The pen makes it impossible; this paragraph says
// why the pen is worth the ceremony.

'use strict';

// ---------------------------------------------------------------------------
// SECTION 1: The board
// ---------------------------------------------------------------------------
// Module-level because there is one crew per process, exactly as there is one swing clock and one set of
// survival reflexes. Nothing here is read before its owner writes it — every section starts EMPTY rather
// than at a plausible default, so a consumer that runs before the commander's first sweep sees `null` and
// can say so, instead of acting on a zero that reads like "no monsters" (Law 13 — never default a missing
// field; a fabricated calm is the falsehood that gets a bot killed).

const SECTIONS = ['commander', 'gunner', 'driver'];

// The empty commander section, spelled out rather than `{}` so every field this board carries is
// enumerated in one readable place — a reader should not have to find the writer to learn the shape.
function _blankCommander() {
  return {
    sweptAt: null,        // ms (Date.now) of the sweep that produced this section, or null before the first
    hostiles: [],         // EVERY hostile loaded this sweep, nearest first, each carrying its aggro verdict
    active: [],           // the subset that passed the aggro test — the threats, nearest first
    tracked: 0,           // hostiles seen this sweep, including the ones that failed the aggro test
    closest: null,        // the nearest ACTIVE hostile descriptor — the WORLD's answer, for reports
    // ── THE FOCUS: WHAT IS SAFE TO SWING AT ──────────────────────────────────────────────────────────
    // Attack only when it is safe to — only when the shield is not needed elsewhere. `focus` is what the
    // gunner swings at and what the driver closes on WHEN NOTHING IS THREATENING, and it is **null
    // whenever every active mob is drawing or swelling** — the honest answer to "what is safe to hit" on
    // those ticks, not a gap to be filled with a fallback. A reader that defaults it to `closest` has
    // restored the offensive stance on exactly the ticks this field exists to suppress.
    //
    // IT IS NOT THE FACING. The gunner points the body at the live THREAT, guard up or not, and only
    // falls back to this when nothing threatens — so `focus` and the gunner's `face` event disagree for
    // most of a defensive fight, and the ratio between them is how the stance is read.
    //
    // An earlier version committed to a single target (rush one mob, ignore the rest) and lost cleanly
    // against a second, unwatched threat while closing on the first — the reason `focus` tracks "safe to
    // hit" rather than "the one target chosen," since commitment ignores whatever it isn't committed to.
    focus: null,
    nearest: null,        // the nearest hostile of ANY aggro state — for reports that ask "what is around"
    engage: null,         // the descriptor the commander says to OPEN a fight with, or null
    engageReason: null,   // 'in_base_seek' | 'aggro' | null
    swelling: [],         // ids of creepers whose server-synched swell direction is UP
    // THE TWO THREAT SIGNALS ARE SHAPED ALIKE ON PURPOSE — both are id lists decoded from server-synched
    // metadata by the one seat allowed to decode anything, and a reader that handles one handles the
    // other. `notching` is every hostile the server says is USING AN ITEM (bit 0 of living_entity_flags),
    // which for a skeleton is a drawn bow. It lives here rather than in the gunner because the commander
    // is the only seat that announces combat data — every other seat reads it — so a second consumer of
    // monster data can be added later at no cost; a decode inside its consumer would instead cost that
    // second consumer a duplicate decode or a cross-seat call.
    notching: [],         // ids of hostiles whose item-use flag is set — a skeleton with an arrow on the string
  };
}

function _blankGunner() {
  return {
    heldYaw: null, targetId: null, lastSwingAt: null, swings: 0,
    // ── THE SHIELD, PUBLISHED RATHER THAN CALLED ACROSS ──────────────────────────────────────────────
    // The gunner raises and lowers it; the DRIVER has to know, because a vanilla client cannot sprint
    // and block at the same time, and mineflayer's own sprint packet can defeat that limit at the
    // protocol level if nothing holds it back — the Rogue Machine error by name (Law 19). The exclusion
    // therefore has to be HELD every tick by the seat that owns sprint, not applied once by the seat that
    // owns the shield.
    //
    // It travels through this board and never as a call between seats (Law 1). A gunner reaching into
    // the driver to drop sprint would put a second writer on the keys, which is the fault the crew split
    // exists to end.
    shield: false,        // is the shield COMMANDED up right now
    shieldWhy: null,      // 'notched_arrow' | 'swell' | 'settling' | null — why, for the record (Law 6)
    shieldAgainst: null,  // entity id the shield is facing; a shield blocks only what it faces

    // ── THE TERRAIN ANSWER — the shield's protocol running the other way ─────────────────────────────
    // Digging and placing need a FACING, and the driver may never write yaw under any circumstance. So
    // the work moves to the seat that already holds the heading rather than the heading moving to the
    // seat that wants the work: one state, one owner, including the awkward case (Invariant D). The
    // driver asks through its own section below; this is the answer, and it travels the same way the
    // shield does — published, never called across (Law 1).
    //
    // FOUR STATES, and `refused` is deliberately not a flavour of `working`: the Architect's protocol
    // separates them ("you might have to wait or i might outright refuse if im busy") and they demand
    // opposite driver behaviour — one means try again, the other means stop asking for this.
    //   refused — a mob is inside strike reach. The yaw is spoken for and the gunner will not yield it.
    //   working — accepted; in flight, or holding for a swing window.
    //   done    — the gunner believes the world changed. A CLAIM, NOT A FACT (Law 23): the driver
    //             re-senses the cell before acting on it. The gunner owes a truthful verdict here
    //             (Law 25) and the driver owes it no trust — both, because the redundancy that would
    //             otherwise catch a wrong answer is exactly what this crew split removed.
    //   failed  — attempted and could not (no material, out of reach, refused by dig authority).
    terrainStatus: null,  // null | { kind, at:{x,y,z}, state, why }
  };
}

function _blankDriver() {
  return {
    keys: null, standingOrder: null, targetId: null,

    // ── THE TERRAIN ASK — a standing WANT, re-published every tick, never a queued message ───────────
    // The Architect's protocol ends "if you have a new plan then ill just stop and continue my origional
    // plan", and the cheapest true form of that is a level-triggered want rather than a request with a
    // cancel: the driver re-states it every tick it still holds, and SILENCE IS THE WITHDRAWAL. A cancel
    // message can be lost, arrive late, or arrive for a request already served, and each of those leaves
    // the gunner digging for a plan that no longer exists. A want that must be re-asserted cannot go
    // stale, and there is no message to lose (Invariant B — never act on what was remembered).
    //
    // The gunner therefore holds no REQUEST of its own; it holds only a dig already IN FLIGHT, and drops
    // that the moment the want stops appearing. That is the same sentence read from the other side.
    //
    // `at` is a block cell, never a route: the ask is per-step ("placing a block here or digging a block
    // there"), because the seat making it is a per-tick step chooser and not a planner.
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
// The returned function REPLACES the section wholesale rather than patching fields, and that is the
// point rather than an inconvenience: a partial write leaves the untouched fields describing an earlier
// instant, so one section would carry two timestamps' worth of truth and nothing on the row would say
// which field came from when (Invariant B). Every seat rebuilds its whole section from fresh state each
// tick anyway — that is what "re-sense" means — so there is nothing a patch would save.
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
    // Frozen at the section and at the one array a reader could realistically push to. The DESCRIPTORS
    // inside `active` are deliberately left thawed: they are rebuilt from scratch every sweep, so a reader
    // that mutated one would corrupt a copy that is discarded 50 ms later — paying a deep freeze 20 times
    // a second to prevent a self-erasing mistake is tick budget spent on nothing.
    for (const k of ['hostiles', 'active', 'swelling', 'notching']) {
      if (Array.isArray(next[k])) Object.freeze(next[k]);
    }
    _board[section] = Object.freeze(next);
  };
}

// ---------------------------------------------------------------------------
// SECTION 3: The read side — free to everyone, and the only thing exported broadly
// ---------------------------------------------------------------------------

// readCommander() → the commander's section, frozen. NEVER null: before the first sweep it is the blank
// shape, whose `sweptAt: null` is the honest way to say "nobody has looked yet" — distinguishable from
// "looked and found nothing" (`sweptAt` set, `active` empty), which is a different fact and one a caller
// acts on differently (Law 25).
function readCommander() { return _board.commander; }
function readGunner() { return _board.gunner; }
function readDriver() { return _board.driver; }

// reset() — wipe every section back to blank WITHOUT releasing the pens.
//
// The split is deliberate and it is Law 8: the pens are process-lifetime (a seat claims once at load and
// holds it until the process ends), while the CONTENTS are per-engagement. Releasing pens on reset would
// mean a seat has to re-claim, and the only code that would re-claim is code that runs more than once,
// which is exactly the second writer the pen exists to forbid.
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
