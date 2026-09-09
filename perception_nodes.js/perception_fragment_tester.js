/**
 * fragment: perception_fragment_tester (injector style)
 * purpose: Test perception fragment functions one at a time
 *        `see functionName`      -> run specific function
 */
const fs = require('fs');
const path = require('path');
const watcher = require('@kernel/watcher');

// ---- Configuration (user editable) ----
const CONFIG = {
  FRAGMENT_NAME: 'mining_blueprinter',  // fragment to test
};

const PERCEPTION_DIR = __dirname;

function resolveFragment(name) {
  const base = name.replace(/\.js$/,'');
  const filePath = path.join(PERCEPTION_DIR, base + '.js');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fragment '${base}.js' not found`);
  }
  // Unguarded: a fragment that will not load is a coding violation, and the wrapper this used to throw
  // replaced the real error's stack with one line — worse for the one job this file has (Law 13).
  return require(filePath);
}

function listFunctions() {
  const fragment = CONFIG.FRAGMENT_NAME;
  const mod = resolveFragment(fragment);
  const functions = Object.keys(mod).filter(key => typeof mod[key] === 'function');
  if (functions.length === 0) {
    watcher.warn('perception_fragment_tester', `No functions found in ${fragment}`);
  } else {
    const fnList = functions.join(', ');
    watcher.summary('perception_fragment_tester', `Available functions in ${fragment}: ${fnList}`);
  }
}

function inject(functionName) {
  const fragment = CONFIG.FRAGMENT_NAME;
  
  // No argument - show usage
  if (!functionName) {
    watcher.warn('perception_fragment_tester', `Usage: see needs function name from module.exports | see <functionName>`);
    return;
  }

  // List command
  if (functionName === 'list') {
    listFunctions();
    return;
  }

  // Run function. UNGUARDED, and this is the file where that matters most: the whole point of the probe
  // is to show what the fragment actually does, and a catch here reduced a real stack to one message line
  // — it hid the answer the operator ran the verb to get (Law 13: surface it loudly).
  const mod = resolveFragment(fragment);
  const fn = mod[functionName];

  if (!fn || typeof fn !== 'function') {
    watcher.error('perception_fragment_tester', `Function '${functionName}' not found in ${fragment} | function names under module.exports`);
    return;
  }

  const bot = global.bot;
  const start = Date.now();

  // Call function with appropriate arguments
  if (fragment === 'path_memory') {
    if (functionName === 'recordWalkedVoxels') {
      const pos = bot.entity.position.floored();
      watcher.summary('perception_fragment_tester', `Calling ${fragment}.${functionName}(position: ${pos.x},${pos.y},${pos.z})`);
      fn(pos);
    } else if (functionName === 'loadPathMemory' || functionName === 'incrementRunCounter') {
      watcher.summary('perception_fragment_tester', `Calling ${fragment}.${functionName}()`);
      fn();
    } else {
      watcher.summary('perception_fragment_tester', `Calling ${fragment}.${functionName}(bot)`);
      fn(bot);
    }
  } else {
    // Default: pass bot object
    watcher.summary('perception_fragment_tester', `Calling ${fragment}.${functionName}(bot)`);
    fn(bot);
  }

  watcher.summary('perception_fragment_tester', `Completed ${fragment}.${functionName}() in ${Date.now() - start}ms`);
}

module.exports = { inject, CONFIG };
