// planner: flock_dye_plan
// purpose: Decides which colour each sheep of a fixed flock wears, from the wool still needed per colour.
//          The flock is bred once to its size and then re-dyed as needs are met; colour is a dye on a live
//          sheep (one dye per sheep, kept through every shear), so no breeding follows the flock's size.
//
// THE RULE. Each colour still needed gets sheep in proportion to its share of the remaining wool, at least
// one sheep each, by largest remainder. When there are more colours than sheep, the colours with the most
// remaining wool get one sheep each and the rest wait for a colour to finish.
//
// Pure: reads only its arguments and returns a plan (Law 2). Nothing in the fleet dispatches on it yet;
// the dyeing act and the job that posts it are the next pieces of this pathway.

'use strict';

const TAG = 'flock_dye_plan';

function remaining(need) {
  if (!need || typeof need !== 'object') throw new Error(`[${TAG}] CODING VIOLATION: need must be { colour: wool }. Got: ${JSON.stringify(need)}`);
  const out = {};
  for (const [colour, wool] of Object.entries(need)) {
    if (!Number.isFinite(wool) || wool < 0) throw new Error(`[${TAG}] CODING VIOLATION: wool still needed for ${colour} must be a number ≥ 0. Got: ${wool}`);
    if (wool > 0) out[colour] = wool;
  }
  return out;
}

// allocate(need, flockSize) → { colour: sheep }, summing to flockSize while any wool is needed.
function allocate(need, flockSize) {
  if (!Number.isInteger(flockSize) || flockSize < 1) throw new Error(`[${TAG}] CODING VIOLATION: flockSize must be a whole number ≥ 1. Got: ${flockSize}`);
  const open = Object.entries(remaining(need)).sort((a, b) => b[1] - a[1]);
  if (open.length === 0) return {};
  const colours = open.slice(0, flockSize);
  const total = colours.reduce((s, [, w]) => s + w, 0);
  const spare = flockSize - colours.length;
  const shares = colours.map(([colour, wool]) => {
    const exact = (wool / total) * spare;
    return { colour, sheep: 1 + Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = flockSize - shares.reduce((s, x) => s + x.sheep, 0);
  for (const x of [...shares].sort((a, b) => b.rest - a.rest)) { if (left-- <= 0) break; x.sheep++; }
  return Object.fromEntries(shares.map(x => [x.colour, x.sheep]));
}

// redyes(current, need) → [{ from, to, sheep }]: the dye moves that turn the flock's current colours into
// allocate()'s plan for what is still needed, fewest sheep moved.
function redyes(current, need) {
  const size = Object.values(current || {}).reduce((s, n) => s + n, 0);
  const want = allocate(need, size);
  const over = [], under = [];
  for (const colour of new Set([...Object.keys(current), ...Object.keys(want)])) {
    const d = (current[colour] || 0) - (want[colour] || 0);
    if (d > 0) over.push({ colour, n: d });
    if (d < 0) under.push({ colour, n: -d });
  }
  const moves = [];
  for (const u of under) {
    while (u.n > 0) {
      const o = over.find(x => x.n > 0);
      const k = Math.min(u.n, o.n);
      moves.push({ from: o.colour, to: u.colour, sheep: k });
      u.n -= k; o.n -= k;
    }
  }
  return moves;
}

module.exports = { allocate, redyes };
