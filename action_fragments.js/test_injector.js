// test_injector.js — Signal Fragment (Lawful Injection for resource_manager's gathering chain)
// Requires the bus at module scope: a forwarding router calls route() with an upstream author's own
// from/to, instead of building an envelope, so it cannot use signal_utils' helpers, which stamp `from`
// as the caller and would overwrite authorship.
const signalBus = require('@kernel/signal_bus');

const TARGET_OBJECT = ['diamond_ore']; // Accepts object names or group tags (e.g., ['crafting_table'], ['logs'])
const QUANTITY = 5;

module.exports = {
  handle: 'test_injector',

  inject: function () {
    const payload = {
      from: 'test_injector',
      to: 'harvest_executor',
      task: 'harvest_executor',
      test: true,
      objective: TARGET_OBJECT,
      quantity: QUANTITY,
      resource_manager: { item: TARGET_OBJECT[0], target: QUANTITY },
      readable: `mimic: collect ${QUANTITY} ${TARGET_OBJECT.join(', ')}`
    };

  // summary() is the right level for a one-line dispatch record; watcher has no signal() method
  // (Law 5: summary/warn/error + buffer/track, nothing else).
  require('@kernel/watcher').summary('test_injector', `[OUT PAYLOAD]\n${JSON.stringify(payload, null, 2)}`);
  signalBus.route(payload.to, payload);
  }
};
