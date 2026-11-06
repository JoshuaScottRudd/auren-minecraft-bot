// fragment: test_module — ONE BEHAVIOUR ON ITS OWN, IN PLACE OF THE PLANNER.
//
// While foreman_config `module` names a test, recursive_judge hands every planning turn here instead of to job_board
// (plannerTarget). The module runs its one test under every rule a job obeys (the judge's loop checks, battle stations,
// the body's own survival) and reports back to the judge. A test runs once per body: when the judge hands the turn
// back after it, the chain ends here and routes nowhere, so the body stands where the test left it and the record is
// read through its lens.
//
// TESTS
//   walk — the foreman asks the server for the nearest `module_biome` (foreman/decoration_locate.locateForModule),
//          and the body walks there by the finder's own walk (sector_finder.walkToward): legs over the navigator,
//          a river swum or its far bank taken, the flattest leg end preferred. Logged as TEST_LOCATE and TEST_WALK,
//          which the --finder lens reads beside the decoration locates.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'test_module';
const TESTS = Object.freeze(['walk']);
let _done = null;   // the readable of this body's finished test, or null while it has not run

// moduleName() → the test the run page names, or null when the crew plans its own work.
function moduleName() {
  const name = require('../foreman_config').module;
  if (name === 'off') return null;
  if (!TESTS.includes(name)) {
    throw new Error(`[${TAG}] CODING VIOLATION: foreman_config.module is '${name}'. Known: 'off' | ${TESTS.map(t => `'${t}'`).join(' | ')}.`);
  }
  return name;
}

// plannerTarget() → the fragment the judge hands a planning turn to: this module while one is on, else job_board.
function plannerTarget() { return moduleName() ? TAG : 'job_board'; }

// locateBiome(bot, test) → the nearest `module_biome` the foreman finds from where the body stands, or found null
// with the reason logged.
async function locateBiome(bot, test) {
  const biome = require('../foreman_config').module_biome;
  const from = bot.entity.position.clone();
  const answer = await require('@kernel/foreman_link').askModuleLocate(biome, from);
  if (!answer || !answer.found) {
    const reason = answer ? answer.reason : 'no_foreman';
    watcher.summary(TAG, `TEST_LOCATE item=biome:${biome} found=none reason=${reason}`);
    return { biome, found: null, readable: `${TAG}: ${test} — no ${biome} located (${reason})` };
  }
  const { x, z, distance } = answer.found;
  watcher.summary(TAG, `TEST_LOCATE item=biome:${biome} found=${answer.found.biome} at=(${x},${z}) distance=${distance} from=(${Math.floor(from.x)},${Math.floor(from.z)})`);
  return { biome, found: answer.found };
}

async function walk(bot) {
  const finder = require('@api/sector_finder');
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const began = Date.now();
  const located = await locateBiome(bot, 'walk');
  if (!located.found) return { success: false, readable: located.readable };
  const { biome } = located;
  const { x, z, distance } = located.found;
  const walked = await finder.walkToward(bot, { x, z });
  const p = bot.entity.position;
  const seconds = Math.round((Date.now() - began) / 1000);
  const left = Math.round(flat({ x, z }, p));
  watcher.summary(TAG, `TEST_WALK item=biome:${biome} arrived=${walked.arrived} walked_s=${seconds} left=${left} at=(${Math.floor(p.x)},${Math.floor(p.z)})`
    + `${walked.arrived ? '' : ` reason=${walked.reason}`}`);
  return {
    success: walked.arrived,
    readable: `${TAG}: walk to ${biome} ${walked.arrived ? 'arrived' : `stopped ${left} b short (${walked.reason})`} after ${seconds}s`,
    walked: { biome, distance, seconds, left, arrived: walked.arrived },
  };
}

module.exports = {
  plannerTarget,
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const name = moduleName();
    if (!name) throw new Error(`[${TAG}] CODING VIOLATION: a signal reached the test module with foreman_config.module 'off'.`);
    if (_done) {
      watcher.summary(TAG, `TEST_DONE module=${name} — the test has run on this body (${_done}); the chain ends here`);
      return;
    }
    const result = await walk(global.bot);
    _done = result.readable;
    return routeToJudge(TAG, { readable: result.readable, [TAG]: { success: result.success, module: name, ...result } });
  }),
};
