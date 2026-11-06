'use strict';
// foreman/utils/run_announcer.js — the foreman says the run's big events in chat, so a person filming knows
// when to move a camera and a take carries its beats.
//
//   start({ fleetState, getBot })   begin once the crew is working; each event is said once per run
//   now()                           read and say at once — the run ending on its building says that building first
//   stop()                          end it, before the fleet is sent home
//
// THE EVENTS, read off the facts every bot already reports to the foreman (foreman_hub.fleetState):
//   a structure standing   the first time any body reads it built (`built`). A structure that is damaged
//                          and repaired is not said again.
//   a layer released       each time the highest layer any body has seen released rises (`layer_released`).
// Nothing else is said: the chat is for moving cameras, not for following the crew.
//
// Each event is written to the foreman's record (`foreman_record.announced`) the moment it is read, which a
// filmed take keeps; the cutting room's timelapse switches cameras on those lines. The chat line follows:
// one line a tick, so a burst (a continue start reading five structures standing) is paced, not flooded.

const timeoutCrash = require('../../js_kernel/utils/timeout_crash');
const record = require('../foreman_record');

const ANNOUNCE_POLL_MS = 1500;
// The server's own limit on one chat line.
const MAX_CHAT_LINE = 256;

const state = { timer: null, said: new Set(), layer: null, read: null, queue: [] };

// The name a person reads: the structure's id with its underscores taken out.
const named = (structure) => `The ${String(structure).replace(/_/g, ' ')}`;

function start({ fleetState, getBot }) {
  state.read = (all = false) => { announce(fleetState); speak(getBot(), all); };
  state.timer = timeoutCrash.every('run_announcer', 'say the run\'s big events in chat', state.read, ANNOUNCE_POLL_MS);
}

function now() {
  if (state.read) state.read(true);
}

function announce(fleetState) {
  const bots = fleetState().bots || [];
  for (const b of bots) {
    for (const [structure, built] of Object.entries(b.built || {})) {
      if (built !== true || state.said.has(structure)) continue;
      state.said.add(structure);
      const text = `${named(structure)} is finished.`;
      state.queue.push(text);
      record.announced('structure', { structure }, text);
    }
  }
  const released = bots.map(b => b.layer_released).filter(Boolean);
  const top = released.reduce((best, r) => (!best || r.layer > best.layer ? r : best), null);
  if (top && (state.layer === null || top.layer > state.layer)) {
    state.layer = top.layer;
    const text = `Layer ${top.layer} of ${top.of} is released for building.`;
    state.queue.push(text);
    record.announced('layer', { layer: top.layer, of: top.of }, text);
  }
}

// The head of the queue (`all`: every line, for the run's last word), said by the foreman's body while it stands in
// the world; a line waits while it does not.
function speak(bot, all) {
  while (state.queue.length && bot && bot.entity) {
    bot.chat(state.queue.shift().slice(0, MAX_CHAT_LINE));
    if (!all) return;
  }
}

function stop() {
  if (state.timer) timeoutCrash.stop(state.timer);
  state.timer = null;
  state.read = null;
  state.queue = [];
}

module.exports = { start, now, stop };
