// fragment: report_to_owner (action / birth) — a contractor arrives WHERE ITS OWNER IS STANDING, so its
// first moment of existence is beside the person who asked for it.
//
// A cell a living player is standing in has a floor, headroom and no lava by the fact of a body already
// standing there — the proof is inherited from that observed fact, the same discipline death_manager's
// anchor tier runs on (an anchor owing no work is a floor that exists), so no scan is needed here.
//
// Runs once, at birth, outside the job board: the call site is the spawn handler, and there is nothing to
// remember afterwards (Law 8).
//
// THE TELEPORT ITSELF IS NOT WRITTEN HERE. death_manager owns "put this body on that cell and prove it
// arrived" — command, verify window, arrival tolerance and an honest verdict when it did not land
// (Law 16). This fragment decides WHERE and borrows HOW.

'use strict';

const watcher = require('@kernel/watcher');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'report_to_owner';

// reportToOwner(bot) → { arrived, at, why }
//
// Every outcome is a sentence, never a throw: an owner missing at spawn time is an ordinary world fact
// (Law 13 — environmental, soft), and the bot can work from where it stands either way.
async function reportToOwner(bot) {
  const { isContractor, currentOwner } = require('@kernel/bot_mandate');
  if (!isContractor()) {
    return { arrived: false, at: null, why: 'not a contractor — a homesteader answers to nobody and begins where the world put it' };
  }
  const owner = currentOwner();

  // This runs inside the spawn handler, unawaited by its caller, so an unhandled rejection would end the
  // process on Node 22. Guarded the way death_manager guards the same link (Law 16).
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

// announce(bot) — the call site's whole interface: does it, logs what happened, never throws upward
// (Law 6).
async function announce(bot) {
  const result = await reportToOwner(bot);
  watcher.summary(TAG, `${result.arrived ? '✓' : '—'} ${result.why}`);

  // ── THE GREETING ──────────────────────────────────────────────────────────────
  // Said here because this is the only place that knows the greeting has an audience.
  //
  // Gated on `result.at` (the owner found standing in the world), not on `arrived`: a failed teleport
  // still leaves a person to greet, but an owner who was never found leaves nobody to address.
  if (result.at) require('@kernel/bot_voice').greet();

  return result;
}

module.exports = { reportToOwner, announce };
