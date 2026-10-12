'use strict';
// foreman/utils/observer.js — a real person watching a run, placed where the crew is placed.
//
// THE CAMERA IS A PERSON, NOT A BODY THE FLEET OWNS. The fleet's own camera stack
// (`Auren_Workshop/camera/`) raises a client per bot and drives it; this is the opposite — the operator
// drives it, and the foreman's job is to make sure they do not have to find the site by hand. So this
// module does exactly two things to that player and never a third: puts it in spectator, and puts it
// where the crew goes.
//
// SPECTATOR, AND THAT IS NOT A CONVENIENCE. A creative body can place and break, and the standing rule is
// that anything Minecraft decides is READ and only the operator's choices are authored; a watcher who can
// lay a block is a watcher who can answer the run's question for it. Spectator also cannot be hit, cannot
// be pathed around, and passes through walls — so the observer changes nothing the crew senses.
//
// ABSENT IS NOT A FAILURE, EVER. The operator may not be logged in when the run starts, may join late, or
// may never join at all, and none of those is a fault in the run — every function here soft-fails and
// says why (Law 13). The placement happens at two moments and they are the same call: once when the site
// is chosen, and again whenever that player joins, so a late join still lands on site.
//
// IT IS OFF UNLESS NAMED. `foreman_config.observer` is '' by default, so a downloaded bot has no magic
// username that behaves differently from any other visitor.

const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'observer';

// The last site the foreman chose, remembered so a player joining mid-run can be placed without the join
// handler having to know how the site was found. Null until the run has a site.
let siteCell = null;

function name() {
  const n = require('../../foreman_config').observer;
  return n && String(n).trim() ? String(n).trim() : null;
}

const isObserver = (who) => !!who && who === name();

function remember(cell) { siteCell = cell; }

// place(who, cell) → { ok, why } — spectator, then the teleport, then READ THE SERVER BACK (Law 25).
// Arrival is proved off the server's own copy of that entity, since a `tp` addressed to a player who is
// not on the server succeeds as a command and moves nobody, and not being logged in is the likely case
// this reads for.
async function place(who, cell) {
  if (!who) return { ok: false, why: 'no observer is named in foreman_config' };
  if (!cell || !Number.isFinite(cell.x) || !Number.isFinite(cell.y) || !Number.isFinite(cell.z)) {
    return { ok: false, why: 'the run has no site yet, so there is nowhere to put the camera' };
  }
  const sent = await guardExternal(TAG, `place the observer ${who}`, () =>
    require('@utils/rcon_link').once([
      `gamemode spectator ${who}`,
      `tp ${who} ${cell.x} ${cell.y + 1} ${cell.z}`,
    ]));
  if (!sent.ok) return { ok: false, why: `the server console refused: ${sent.reason}` };

  const read = await guardExternal(TAG, `read where ${who} is`, () =>
    require('@utils/rcon_link').once([`data get entity ${who} Pos`]));
  if (!read.ok) return { ok: false, why: `could not read the camera back: ${read.reason}` };
  const said = read.value[0].body || '';
  // A disconnected player's reply is "No entity was found", not a position — the read-back checks for it.
  const nums = said.match(/-?\d+\.\d+/g);
  if (!nums || nums.length < 3) return { ok: false, why: `${who} is not in the world (the server says "${said.trim()}")` };
  const here = { x: Math.floor(Number(nums[0])), y: Math.floor(Number(nums[1])), z: Math.floor(Number(nums[2])) };
  const off = Math.hypot(here.x - cell.x, here.z - cell.z);
  return off <= 4
    ? { ok: true, why: `${who} is in spectator at (${here.x},${here.y},${here.z})` }
    : { ok: false, why: `${who} reads (${here.x},${here.y},${here.z}), ${off.toFixed(0)} blocks from the site` };
}

// atSite() — place the named observer at the remembered site. The one call both the startup step and the
// join handler make, so where the camera goes is decided once (Law 16).
const atSite = () => place(name(), siteCell);

module.exports = { name, isObserver, remember, place, atSite };
