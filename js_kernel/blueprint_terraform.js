// js_kernel/blueprint_terraform.js — ONE method for the ground under a DOWNLOADED blueprint: the scrape, the
// basement it bottoms out in, and the stair down into it. Pure: numbers in, a target shape in the blueprint's own
// frame out. It reads no world and writes no file.
//
// ── TERRAFORM AND BASEMENT ARE ONE PIECE (Architect 2026-09-17) ──────────────────────────────────────
// *"terraform and basement are one piece. its redundant. if terraform scrapes layer by layer then it should keep
// scraping until the basement is done including the staircase. its just a little wider than all the other level
// scrapes to include the stiars. so 2 blocks longer in horizontal to scrape and it naturally makes stairs. so
// terraform and basement are one method."*
// There is no basement job and no stair job. There is a scrape that starts at the highest block over the site and
// does not stop until the lowest target layer is empty; the basement is the part of it below the blueprint's lowest
// layer, and the stair is the part of it that reaches outside the footprint. The stair is not cut, it is LEFT: each
// layer's lane runs one step further out than the layer below it, so the lane's side profile is already a staircase
// when the scrape bottoms out. One step is `stairWidth` cells, which is his "2 blocks longer in horizontal".
//
// ── PARALLEL LINES, NEVER A CROSS (Architect 2026-09-17) ────────────────────────────────────────────
// *"the method is to take a single 1 by 1 at a y layer that picks the longer run and locks it in. so if its a
// rectangle then the scrape lines go long. if its a perfect square then it picks on and locks it in. i dont want
// intersecting perpendicular lines. parallel lines."*
// The lane at any one layer is therefore a MOVING WINDOW of two steps, not a growing wedge: at layer y the only
// open lane cells are the step whose tread is at y and the one whose headroom is, so the lane is `stairWidth` × 2
// cells and it marches one step further out each layer down. That is his "2 blocks longer in horizontal" exactly —
// it was read as cumulative once, which made the stair an open trench costing 72 blocks on the castle instead of 30.
//
// A claim is ONE LINE: 1 block wide, the full run of the layer, along the LONGER of the two horizontal dimensions.
// A square locks 'x'. Every line in a layer is parallel to every other, so no two claims can ever cross and a bot
// dropped mid-line leaves a gap no other bot is standing in. How many bots can scrape at once is therefore the
// SHORT dimension of the site, not its area.
//
// ── THE WORLD IS THE PROGRESS LEDGER (Architect 2026-09-17) ─────────────────────────────────────────
// *"a bot could be interrupted at any time so a fresh scan of what needs to be terraformed needs to happen every
// scan instead of writing down what is done in memory."*
// Nothing here records what has been dug. This module states the TARGET SHAPE — which cells must end as air, and at
// which layer each one belongs — and the runtime answers "what is left" by reading the world every cycle: the
// active layer is the highest layer with a block still standing in it, and a line is available while any of its
// cells at that layer still holds one. A plan that carried progress would be a second copy of a fact the world
// already states (Law 16), and it is exactly the copy an interrupted bot leaves wrong.
//
// ── THREE PHASES, IN ORDER ──────────────────────────────────────────────────────────────────────────
//   1. TREES    every log and leaf over the site comes down first, so nothing is left hanging in the air
//               when the ground under it is taken away. The logs are the build's wood supply.
//   2. SCRAPE   layer by layer, highest to lowest, in parallel lines, down past the blueprint's lowest
//               layer to the basement floor. The stair is what the lanes leave behind.
//   3. SEAL     when the building is finished, the stair is filled back so a player sees natural ground.
//               The crawlspace is never filled.
//
// ── THE FRAME ───────────────────────────────────────────────────────────────────────────────────────
// Blueprint frame: x 0..w-1, z 0..l-1, layer 0 = the blueprint's lowest layer. Ground floor layer G sits at the
// natural ground height h, so world y = h - G + blueprint y. Layers below 0 are the basement:
//   CRAWLSPACE  the whole footprint, BASEMENT_HEIGHT high, at y -BASEMENT_HEIGHT..-1. Bots walk it and pillar up
//               into each column's stand column from it.
//   FLOOR       y -BASEMENT_HEIGHT-1 is never dug; it is what the crawlspace stands on.
//   STAIR       outside the footprint on the operator's side, centred, `stairWidth` wide. Step d (1 touches the
//               footprint) has its walking surface at feet y -BASEMENT_HEIGHT + (d-1), rising one per step until the
//               last step's tread sits in the surface layer G and the bot walks out onto natural ground.
//               A STEP IS TWO CELLS TALL — the tread and the headroom — AND NOTHING ABOVE IT IS TOUCHED. It is a
//               covered stairwell, not an open trench: the natural ground over it is the roof, so the only thing a
//               player can see is the mouth at the top step.

'use strict';

const GROUND_SHARE = 0.5;
const BASEMENT_HEIGHT = 2;
const SIDES = ['north', 'south', 'east', 'west'];
const DEFAULT_STAIR_SIDE = 'north';
const DEFAULT_STAIR_WIDTH = 2;
// How far outside the footprint the tree pass reaches. A large oak's leaves sit up to 5 blocks from the trunk,
// so 6 clears every leaf that can overhang the site from a trunk standing just outside it.
const TREE_MARGIN = 6;

function groundFloorLayer(voxels) {
  const columns = new Set(voxels.map(v => `${v[0]},${v[2]}`)).size;
  const dirtPerLayer = new Map();
  for (const v of voxels) if (v[3] === 'dirt') dirtPerLayer.set(v[1], (dirtPerLayer.get(v[1]) || 0) + 1);
  const layers = [...dirtPerLayer.entries()].filter(([, n]) => n >= GROUND_SHARE * columns).map(([y]) => y);
  return { layer: layers.length ? Math.max(...layers) : 0, share: layers.length ? dirtPerLayer.get(Math.max(...layers)) / columns : 0, columns };
}

// planTerraform(voxels, dims, { stairSide = 'north', stairWidth = 2 }) → the target shape, or a correction when the
// operator names a side or a width that is not one (Law 13: an operator choice is corrected with the form that works).
function planTerraform(voxels, dims, { stairSide = DEFAULT_STAIR_SIDE, stairWidth = DEFAULT_STAIR_WIDTH } = {}) {
  if (!SIDES.includes(stairSide)) {
    return { ok: false, reason: `the stair side is the operator's choice of where the hub stands, and "${stairSide}" is not a side. Give one of: ${SIDES.join(', ')} (north = toward -z, west = toward -x).` };
  }
  if (!Number.isInteger(stairWidth) || stairWidth < 1) {
    return { ok: false, reason: `stair width "${stairWidth}" must be a whole number of blocks, at least 1 (${DEFAULT_STAIR_WIDTH} is the ratified width).` };
  }
  const ground = groundFloorLayer(voxels);
  const G = ground.layer;
  const bottomY = -BASEMENT_HEIGHT;                 // the lowest layer that is dug
  const floorY = bottomY - 1;                       // never dug
  const steps = (G + 1) - bottomY;                  // crawlspace feet up to feet on the natural ground

  // The lines run along the LONGER dimension; a square locks x.
  const axis = dims.l > dims.w ? 'z' : 'x';
  const across = axis === 'z' ? 'x' : 'z';
  const runLength = axis === 'z' ? dims.l : dims.w;
  const lineCount = axis === 'z' ? dims.w : dims.l;

  // The stair lane, in the blueprint frame. `outward` is the direction it leaves the footprint.
  const alongStairEdge = stairSide === 'north' || stairSide === 'south' ? 'x' : 'z';
  const laneSpan = alongStairEdge === 'x' ? dims.w : dims.l;
  const laneFirst = Math.floor((laneSpan - stairWidth) / 2);
  const stairAxis = alongStairEdge === 'x' ? 'z' : 'x';
  const stairCells = [];
  for (let d = 1; d <= steps; d++) {
    const feetY = bottomY + (d - 1);
    // TWO CELLS PER STEP — the tread the bot stands in and the one over its head — and no more. Anything
    // above that is natural ground doing the job of a roof for free. The top step needs only its tread,
    // because the cell over it is already open air above the surface.
    const headY = Math.min(feetY + 1, G);
    for (let k = 0; k < stairWidth; k++) {
      const a = laneFirst + k;
      const [x, z] = stairSide === 'north' ? [a, -d] : stairSide === 'south' ? [a, dims.l - 1 + d]
        : stairSide === 'west' ? [-d, a] : [dims.w - 1 + d, a];
      stairCells.push({ x, z, step: d, feet_y: feetY, open_from_y: feetY, open_to_y: headY, floor_y: feetY - 1 });
    }
  }
  // When the lines already run toward the stair side, the lane is the same lines carrying on past the footprint
  // edge — his "2 blocks longer in horizontal". When they run across it, the lane is its own short lines, still
  // parallel to nothing else at that layer because the lane lies outside the footprint entirely.
  const laneExtendsLines = stairAxis === axis;

  return {
    ok: true,
    ground_floor_layer: G,
    ground_floor_dirt_share: Math.round(ground.share * 100) / 100,
    world_y: 'world y = h - ground_floor_layer + blueprint y, where h is the ring-median natural ground height',
    scrape: {
      axis, across, lines: lineCount, run_length: runLength,
      footprint: { x: [0, dims.w - 1], z: [0, dims.l - 1], columns: dims.w * dims.l },
      from_y: 'the highest block standing over the site — read from the world, never from this plan',
      to_y: bottomY,
      layers_below_ground_floor: G + BASEMENT_HEIGHT,
      lane_extends_lines: laneExtendsLines,
    },
    // ── PHASE ONE: THE TREES COME DOWN FIRST (Architect 2026-09-17) ───────────────────────────────
    // *"a part of terraform is tree removal. i dont want leaf or log blocks hanging in the air so terraform
    // does a tree removal pass before scraping land."* A scrape that starts under a canopy leaves the canopy
    // hanging: the layer that held the trunk is cleared, the leaves above it are not, and leaf decay is both
    // slow and unreliable when a log remains anywhere within its radius. So logs and leaves go FIRST, over
    // the whole site, and only then does the layer-by-layer scrape begin.
    // The region is the footprint plus TREE_MARGIN, because a trunk standing outside the footprint carries
    // leaves over it — clearing only the footprint would leave exactly the floating canopy he is naming.
    // This is also where the build's WOOD COMES FROM: the material rule builds every wood block from one
    // species (§23), and the site's own trees are that species by definition.
    trees: {
      when: 'before the first scrape line — the whole site, not layer by layer',
      region: { x: [0 - TREE_MARGIN, dims.w - 1 + TREE_MARGIN], z: [0 - TREE_MARGIN, dims.l - 1 + TREE_MARGIN], margin: TREE_MARGIN },
      clears: 'every log and every leaf block standing in the region, read fresh from the world each cycle',
      done_when: 'the region holds no log and no leaf above the natural ground',
      wood: 'the logs are the build\'s wood supply — they go to the hub chests, not on the ground',
    },
    crawlspace: { min: [0, bottomY, 0], max: [dims.w - 1, -1, dims.l - 1], height: BASEMENT_HEIGHT, cells: dims.w * dims.l * BASEMENT_HEIGHT },
    floor_y: floorY,
    stair: {
      side: stairSide, width: stairWidth, steps, first_along_edge: laneFirst, along: alongStairEdge,
      cells: stairCells,
      blocks_dug_if_ground_is_level: stairCells.reduce((s, c) => s + Math.max(0, c.open_to_y - c.open_from_y + 1), 0),
    },
    // ── THE SEAL, WHEN THE BUILDING IS DONE (Architect 2026-09-17) ─────────────────────────────────
    // *"crawlspace is empty but the staircase is sealed so its not visble to a player."* The crawlspace stays
    // open and unreachable; only the stair is filled, and it is filled back to exactly the cells the scrape
    // took — `stair.cells`, each from its `open_from_y` up to its `open_to_y`. Order is the deepest step first,
    // each column bottom to top: the bot fills the two cells of a step, steps out and up into the next step
    // above, and repeats — so it rises with the fill, leaves through the mouth, and is never sealed in. Dirt,
    // so the top step matches the ground the ring rule set it to and grass spreads over the seam on its own.
    // Only the MOUTH is visible before this runs, so sealing costs a fraction of what an open trench would.
    seal: {
      when: 'the blueprint is finished — the last column sealed on its descent',
      cells: 'stair.cells, each filled from open_from_y up to open_to_y',
      order: 'deepest step (d = 1) first, each column bottom to top',
      block: 'dirt',
      blocks: stairCells.reduce((s, c) => s + Math.max(0, c.open_to_y - c.open_from_y + 1), 0),
      crawlspace: 'left empty and unreachable — never filled',
      leaves_the_bot: 'on the natural ground outside the footprint',
    },
  };
}

// linesAtLayer(plan, y) → the claims available at one layer, in order across the site. One line is one claim: a
// 1-wide run of cells that one bot clears end to end. `from`/`to` are inclusive along `plan.scrape.axis`.
// Nothing here says which of them still has blocks in it — that is the world's to state, read fresh every cycle.
function linesAtLayer(plan, y) {
  const { axis, across, footprint } = plan.scrape;
  const lo = across === 'x' ? footprint.x[0] : footprint.z[0];
  const hi = across === 'x' ? footprint.x[1] : footprint.z[1];
  const from = axis === 'x' ? footprint.x[0] : footprint.z[0];
  const to = axis === 'x' ? footprint.x[1] : footprint.z[1];
  const open = plan.stair.cells.filter(c => y >= c.open_from_y && y <= c.open_to_y);
  const lines = [];
  for (let a = lo; a <= hi; a++) {
    const line = { [across]: a, axis, from, to, stair_cells: [] };
    for (const c of open) if ((across === 'x' ? c.x : c.z) === a) line.stair_cells.push([c.x, c.z]);
    // A lane that carries on past the footprint edge is the same claim, just longer.
    for (const [cx, cz] of line.stair_cells) {
      const at = axis === 'x' ? cx : cz;
      line.from = Math.min(line.from, at);
      line.to = Math.max(line.to, at);
    }
    lines.push(line);
  }
  // A lane that lies across the lines is its own claim, outside the footprint and parallel to the rest.
  for (const c of open) {
    const a = across === 'x' ? c.x : c.z;
    if (a >= lo && a <= hi) continue;
    let line = lines.find(l => l[across] === a);
    if (!line) { line = { [across]: a, axis, from: Infinity, to: -Infinity, stair_cells: [] }; lines.push(line); }
    line.stair_cells.push([c.x, c.z]);
    const at = axis === 'x' ? c.x : c.z;
    line.from = Math.min(line.from, at);
    line.to = Math.max(line.to, at);
  }
  return lines.sort((p, q) => p[across] - q[across]);
}

module.exports = { planTerraform, linesAtLayer, groundFloorLayer, BASEMENT_HEIGHT, DEFAULT_STAIR_SIDE, DEFAULT_STAIR_WIDTH };
