// test_injector.js — Signal Fragment (Lawful Injection for resource_manager's gathering chain)

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

  // watcher.signal() does not exist (Law 5: summary/warn/error + buffer/track, nothing else), so this
  // was a guaranteed TypeError that the empty catch hid permanently — the payload has never once been
  // logged. summary() is the right level for a one-line dispatch record (r33/F6).
  require('@kernel/watcher').summary('test_injector', `[OUT PAYLOAD]\n${JSON.stringify(payload, null, 2)}`);
  const signalBus = require('@kernel/signal_bus');
  signalBus.route(payload.from, payload.to, payload);
  }
};
