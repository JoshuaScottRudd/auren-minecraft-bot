// fragment: herd_manager (action / ranching)
// Routing head of the herd: one body brings one animal into its crew's pen, then banks its wheat.
//   - Sense    = the pen record (pen_gate.jobPen) and the free animal nearest the body (animal_finder.seek),
//                skipping every animal a peer's herd already names; from it THE STRING (animal_finder.stringOf):
//                the next free animal nearest the last one tied, each hop a priced walk, until HERDING.string_blocks
//                is spent, HERDING.string_max are tied, or the pen has no more room.
//   - Executor = herd_executor.herdAnimal — the string led in at once (Law 15 API).
//   - Exit     = pen_gate.leavePen (back along the axis, through the open gate, shut behind), then the standby cell is
//                given up — the bringer's word `out`, on which the shepherd leaves — and the wheat banked: wheat
//                carried between herds is wheat a body may show by chance, and every sheep near it follows.
// One signal lives for the whole herd (Law 4) and it ends at recursive_judge.
//
// THE BRINGER IS A TENDER (herd_executor, pen_gate). One herd at a time (assessors/ranching posts one slot). A tender
// standing by at the pen with no shepherd has the board post an urgent shepherd job (shepherd_manager); no gate opens
// without a shepherd holding the flock. The animals this body's string ties are written on its magnet (`animal_id`, the
// nearest, and `animal_ids`, the whole string), so a peer's seek and string skip them and the pen counts them as coming.
//
// THE HERD LEDGER. Every herd ends with one `[HERD_LEDGER]` line of key=value fields, written here because only the
// manager holds the whole herd: result, role, seconds by step (pen_gate.tendClock: fetch, seek, string, out, gather, lead,
// standby_queue, shepherd_wait, gate_wait, cross, drop, exit, bank) and total_s, legs, reacquires, the flock taken in
// and missed, who held for it, the exit, the wheat banked, where the animal stood, and the standby cell. Each step
// change is its own `[HERD_STEP]` line as it happens. monitoring/herding_lens reads both (--herding). An absent value
// is '-'.

'use strict';

const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const { HERDING } = require('@thinking/architect_config');
const { retrieveItems, depositItems } = require('@api/inventory_swapper');
const { jobPen, penGeometry, leavePen, releasePark, sayPhase, tendClock, penned, flockOf, herdsUnderway } = require('@api/pen_gate');
const { herdAnimal, kvLine } = require('@action/herd_executor');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'herd_manager';
const LURE = 'wheat';

// animal id → when this body could not reach it. An animal no route reaches (fenced in, across water, in a hole), or one
// stuck in the cell it was found in after every reacquire (herd_executor's metrics.stuck), is skipped for HERDING.unreachable_skip_ms, so the next herd picks another instead of walking at the same one again.
// The decision and its memory belong to the same seat (Invariant D). Swept on write.
const UNREACHED = new Set(['route_to_animal_failed', 'animal_out_of_reach']);
const _unreached = new Map();
function noteUnreached(id, now) {
  _unreached.set(id, now);
  for (const [k, at] of _unreached) if (now - at > HERDING.unreachable_skip_ms) _unreached.delete(k);
}
const skippedAnimals = now => [..._unreached].filter(([, at]) => now - at <= HERDING.unreachable_skip_ms).map(([id]) => id);

const wheatHeld = bot => bot.inventory.items().filter(i => i.name === LURE).reduce((n, i) => n + i.count, 0);

// herdLedger: the one machine line per herd. `fields` is an ordered object; null/undefined print as '-'.
function herdLedger(fields) {
  watcher.summary('herd_ledger', `herd ${kvLine(fields)}`);
}
const STEPS = ['fetch', 'seek', 'string', 'out', 'gather', 'lead', 'standby_queue', 'shepherd_wait', 'gate_wait', 'cross', 'drop', 'exit', 'bank'];
const stepFields = t => Object.fromEntries(STEPS.map(s => [`${s}_s`, t[s] ?? null]));

function _finish(success, readable, metrics) {
  if (success) watcher.summary(TAG, readable); else watcher.warn(TAG, readable);
  routeToJudge(TAG, { readable, [TAG]: { success, readable, metrics } });
}

// The animals peers are leading, read from their magnets.
function peerTargets(selfId) {
  return Object.entries(hq.getFullBoardroom({}))
    .filter(([id, chair]) => id !== selfId && Number.isInteger(chair?.magnet?.animal_id))
    .flatMap(([, chair]) => Array.isArray(chair.magnet.animal_ids) ? chair.magnet.animal_ids : [chair.magnet.animal_id]);
}

function noteTarget(botId, animalIds) {
  const chair = hq.readBoardroomChair(botId, {}) || {};
  if (!chair.magnet) return;
  chair.magnet = { ...chair.magnet, animal_id: animalIds[0], animal_ids: animalIds };
  hq.writeBoardroomChair(botId, chair);
}

// Banks every wheat the body carries.
async function bankWheat(bot) {
  const n = wheatHeld(bot);
  if (n === 0) return 0;
  const r = await depositItems(bot, LURE, n);
  return r ? r.transferred : null;
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the herd manager ran.`);
    const botId = process.env.BOT_ID || 'default';
    const { pen } = jobPen(botId) || {};
    if (!pen) return _finish(false, `${TAG}: the job names none of this crew's locked pens`, {});

    const clock = tendClock('bringer');
    clock.to('fetch');
    if (wheatHeld(bot) === 0 && await retrieveItems(bot, LURE, 1) === undefined) return;   // abandoned to the judge
    if (wheatHeld(bot) === 0) {
      const { t, total } = clock.done();
      herdLedger({ result: 'no_wheat_in_chests', role: 'bringer', total_s: total, ...stepFields(t) });
      return _finish(false, `${TAG}: no wheat in the chests to lead with`, {});
    }

    clock.to('seek');
    // The nearest free animal this body senses; with none, the sector walk looks further (animal_finder.seek).
    const found = await require('@api/animal_finder').seek(bot, pen.animal, {
      pens: [pen], skip: [...peerTargets(botId), ...skippedAnimals(Date.now())],
    });
    if (!found.animal) {
      clock.to('bank');
      const banked = await bankWheat(bot);
      if (banked === null) return;   // the deposit abandoned to the judge
      const { t, total } = clock.done();
      herdLedger({ result: `no_free_${pen.animal}`, role: 'bringer', seek_reason: found.reason, seek_walks: found.walks, total_s: total, ...stepFields(t), banked });
      return _finish(false, `${TAG}: no free ${pen.animal} found (${found.reason}, ${found.walks} walk(s), last section ${found.section ?? 'none'}); banked ${banked} wheat`, { walks: found.walks });
    }
    // THE STRING, never longer than the pen has room for past the animals in it and every animal a peer leads in.
    clock.to('string');
    const skip = [...peerTargets(botId), ...skippedAnimals(Date.now())];
    const room = flockOf(penGeometry(pen)) - penned(bot, penGeometry(pen), pen.animal).length - herdsUnderway(botId, pen.structure);
    const string = await require('@api/animal_finder').stringOf(bot, pen.animal, found.animal, {
      pens: [pen], skip, blocks: HERDING.string_blocks, max: Math.max(1, Math.min(HERDING.string_max, room)), sliceMs: HERDING.string_slice_ms,
    });
    noteTarget(botId, string.ids);

    const herd = await herdAnimal(bot, found.animal.id, pen, clock, string.ids);
    if (UNREACHED.has(herd.result) || herd.metrics.stuck) noteUnreached(found.animal.id, Date.now());
    clock.to('exit');
    const out = await leavePen(bot, pen, pen.animal, { gateHeld: herd.metrics.gate_held === true });
    // Out with the gate shut, the standby cell is given up and the bringer says it is out: the shepherd leaves on that
    // word, and the next tender may take the cell.
    if (herd.metrics.park_held) {
      const geo = penGeometry(pen);
      sayPhase(geo, botId, 'bringer', 'out');
      releasePark(geo, botId);
    }
    clock.to('bank');
    const banked = await bankWheat(bot);
    if (banked === null) return;   // the deposit abandoned to the judge
    const { t, total } = clock.done();
    const hm = herd.metrics;
    herdLedger({
      result: herd.result, role: 'bringer', animal: found.animal.id, seek_walks: found.walks, total_s: total, ...stepFields(t),
      string: string.ids.length, string_blocks: string.blocks, gathered: hm.gathered,
      legs: hm.legs, reacquires: hm.reacquires, flock: hm.flock, flock_in: hm.flock_in, missed: hm.missed, pen_count: hm.pen_count, stuck: hm.stuck,
      axis_spikes: hm.axis_spikes, axis_dug: hm.axis_dug, axis_out_of_reach: hm.axis_out_of_reach, off_cell: hm.off_cell,
      shepherd: hm.shepherd, foreign: hm.foreign, shooed: hm.shooed, foreign_at_heel: hm.foreign_at_heel, foreign_penned: hm.foreign_penned,
      escaped: out.escaped ?? null, escaped_at: out.escaped_at || null, exit_fault: out.fault || null,
      banked, animal_at: hm.animal_at, park: hm.park,
    });
    const exit = out.fault ? `left the pen: FAILED ${out.fault}` : `left the pen, ${out.escaped} escaped`;
    _finish(herd.success && !out.fault, `${herd.readable}; ${exit}; banked ${banked} wheat; ${total}s in all`,
      { ...hm, result: herd.result, exit_fault: out.fault || null, escaped: out.escaped || 0, seconds: total });
  }),
};
