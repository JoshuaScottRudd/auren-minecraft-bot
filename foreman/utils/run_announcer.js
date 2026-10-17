'use strict';
// foreman/utils/run_announcer.js — the foreman says the run's big events in chat, so a person filming knows
// when to move a camera.
//
//   start({ fleetState, say })   begin once the crew is working; each event is said once per run
//   now()                        read and say at once — the run ending on its building says that building first
//   stop()                       end it, before the fleet is sent home
//
// THE EVENTS, read off the facts every bot already reports to the foreman (foreman_hub.fleetState):
//   a structure standing   the first time any body reads it built (`built`). A structure that is damaged
//                          and repaired is not said again.
//   a layer released       each time the highest layer any body has seen released rises (`layer_released`).
// Nothing else is said: the chat is for moving cameras, not for following the crew.
//
// Each line said is also written to the foreman's record (`foreman_record.announced`), which a filmed
// take keeps; the cutting room's timelapse switches cameras on those lines.

const timeoutCrash = require('../../js_kernel/utils/timeout_crash');
const record = require('../foreman_record');

const ANNOUNCE_POLL_MS = 6000;

const state = { timer: null, said: new Set(), layer: null, read: null };

// The name a person reads: the structure's id with its underscores taken out.
const named = (structure) => `The ${String(structure).replace(/_/g, ' ')}`;

function start({ fleetState, say }) {
  state.read = () => announce(fleetState, say);
  state.timer = timeoutCrash.every('run_announcer', 'say the run\'s big events in chat', state.read, ANNOUNCE_POLL_MS);
}

function now() {
  if (state.read) state.read();
}

function announce(fleetState, say) {
  const bots = fleetState().bots || [];
  for (const b of bots) {
    for (const [structure, built] of Object.entries(b.built || {})) {
      if (built !== true || state.said.has(structure)) continue;
      state.said.add(structure);
      const text = `${named(structure)} is finished.`;
      say(text);
      record.announced('structure', { structure }, text);
    }
  }
  const released = bots.map(b => b.layer_released).filter(Boolean);
  const top = released.reduce((best, r) => (!best || r.layer > best.layer ? r : best), null);
  if (top && (state.layer === null || top.layer > state.layer)) {
    state.layer = top.layer;
    const text = `Layer ${top.layer} of ${top.of} is released for building.`;
    say(text);
    record.announced('layer', { layer: top.layer, of: top.of }, text);
  }
}

function stop() {
  if (state.timer) timeoutCrash.stop(state.timer);
  state.timer = null;
  state.read = null;
}

module.exports = { start, now, stop };
