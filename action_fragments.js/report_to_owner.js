// fragment: report_to_owner (action / birth) — a contractor arrives WHERE ITS OWNER IS STANDING.
//
// ── WHY A CONTRACTOR IS NOT LEFT AT WORLD SPAWN ────────────────────────────────────────────────────
// A homesteader's first act is to find a world worth settling, so vanilla's spawn point is a legitimate
// place to begin. A contractor's whole existence starts from a person asking for one, and that person is
// standing somewhere specific when they ask. Landing it at world spawn would make the first thing every
// contractor does a walk to a human it cannot see, over terrain nobody chose, with no verb for the human
// to say "over here" — so the arrival is part of being fetched, not a job to be planned.
//
// ── WHY THE OWNER'S EXACT CELL, AND WHY THAT IS SAFE WITHOUT A SCAN ────────────────────────────────
// The Architect's ruling, and the reasoning is the whole reason this file is short: *"theres no collision
// with mineflayer bots so a place where the human is standing = safe because the human is standing
// there."* A cell occupied by a living player is a cell with a floor, headroom and no lava — not because
// anything here checked, but because a body is already standing in it. The proof is INHERITED from an
// observed fact rather than derived from a scan, which is the same discipline death_manager's anchor tier
// runs on (an anchor owing no work is a floor that exists).
//
// The wrong turn, named because it was designed in full before it was cut: probing the ring around the
// player over RCON for a legal cell "as close as legally possible". It is a whole sensing mechanism
// answering a question a standing human has already answered, and every one of its failure modes (no
// legal cell, an unreadable block reply, a player mid-fall) is a way to land the body somewhere WORSE
// than the spot that was known good. Two entities in one cell is a non-event for a client with no
// collision; the scan was machinery bought with nothing.
//
// ── ONE-SHOT, AT BIRTH, OUTSIDE THE LOOP ──────────────────────────────────────────────────────────
// Not a job on the board. A job is re-posted until its gap closes, and this one's gap ("am I at my
// owner?") reopens the moment either body walks — a contractor would then be dragged to its owner's heel
// forever instead of working. Birth happens once and the process is its lifecycle (Law 8), so the call
// site is the spawn handler and there is nothing to remember afterwards.
//
// THE TELEPORT ITSELF IS NOT WRITTEN HERE. death_manager already owns "put this body on that cell and
// prove it arrived" — command, verify window, arrival tolerance and an honest verdict when it did not
// land (Law 16). This fragment decides WHERE and borrows HOW.

'use strict';

const watcher = require('@kernel/watcher');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'report_to_owner';

// reportToOwner(bot) → { arrived, at, why }
//
// EVERY OUTCOME IS A SENTENCE, NEVER A THROW. An owner who logged off between the launch and the spawn is
// an ordinary world fact, not a defect (Law 13 — environmental, soft), and the bot is perfectly able to
// work from where it stands. The caller logs the verdict and carries on either way, so what this owes is
// a true statement about what happened (Law 25), not a decision about whether the run may continue.
async function reportToOwner(bot) {
  const { isContractor, currentOwner } = require('@kernel/bot_mandate');
  if (!isContractor()) {
    return { arrived: false, at: null, why: 'not a contractor — a homesteader answers to nobody and begins where the world put it' };
  }
  const owner = currentOwner();

  // A REAL BOUNDARY, and it is load-bearing rather than decorative: this runs inside the spawn handler,
  // it is not awaited by its caller, and an unhandled rejection ENDS THE PROCESS on Node 22 — so an RCON
  // socket that refuses would not degrade the arrival, it would delete the bot. Guarded the way
  // death_manager guards the same link (Law 16), because the throw originates in the rcon session and
  // not in this fragment.
  const read = await guardExternal(TAG, `rcon read of ${owner}'s position`,
    () => require('../js_kernel/utils/rcon_link').entityPos(owner));
  if (!read.ok) {
    return { arrived: false, at: null, why: `could not ask the server where ${owner} is (${read.reason}) — starting from the spawn point` };
  }
  const at = read.value;
  if (!at) {
    return { arrived: false, at: null, why: `${owner} is not in the world right now, so there is nowhere to report to — starting from the spawn point` };
  }

  const { teleportTo } = require('@action/death_manager.js');
  const tp = await teleportTo(bot, at);
  if (!tp.moved) {
    return { arrived: false, at, why: `the teleport to ${owner} at (${at.x},${at.y},${at.z}) did not land: ${tp.error}` };
  }
  return { arrived: true, at, why: `standing where ${owner} was standing, at (${at.x},${at.y},${at.z})` };
}

// announce(bot) — the call site's whole interface: do it, say what happened, never throw upward.
// A birth step that could kill the process would make a contractor's arrival a reason not to have a
// contractor, so the boundary terminates here and the verdict goes to the log (Law 6).
async function announce(bot) {
  const result = await reportToOwner(bot);
  watcher.summary(TAG, `${result.arrived ? '✓' : '—'} ${result.why}`);

  // ── THE GREETING (Architect 2026-09-06: *"the bots should do a greeting"*) ──────────────────────────
  // HERE AND NOWHERE ELSE, because this is the only place that knows the greeting has an audience. A
  // contractor spawns at world spawn and is carried to its owner; a line said at spawn would be addressed
  // to somebody two hundred blocks away, and a line said from the spawn handler would race the teleport.
  //
  // GATED ON `result.at`, WHICH IS THE OWNER HAVING BEEN FOUND STANDING IN THE WORLD — not on `arrived`.
  // A teleport that failed still leaves a person to greet and a bot that is theirs and working; an owner
  // who logged off between the launch and the spawn leaves nobody, and greeting them would be a line in
  // front of everybody else addressed to somebody who is not there, which is the exact noise this whole
  // day's work is removing.
  if (result.at) require('@kernel/bot_voice').greet();

  return result;
}

module.exports = { reportToOwner, announce };
