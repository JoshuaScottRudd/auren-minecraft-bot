// js_kernel/floor_stack.js
// One building from separate floors: each piece of building_blueprints.json's `floors` section is written in its own frame,
// y 0 its slab and y 1..3 its room, and this stacks the named pieces bottom first with the roof on top. Pure: file data in, a
// building entry out, so a floor's blocks, anchors, stands and beds have one statement however many towers use it (Law 16).
// The stack's height is the number of pieces, and Structure Studio's floor_workbench.stack is the same arrangement for drafts.

'use strict';

const HEIGHT = 4;

const raise = (p, y0) => [p[0], p[1] + y0, p[2], ...p.slice(3)];

// stackFloors(name, pieces, { floors, roof }) → the building entry, in the shape blueprint_registry serves. `floors` names the
// occupied storeys bottom first; the first is a ground piece, whose slab has no stair opening, and the rest are upper pieces.
function stackFloors(name, pieces, { floors, roof, title, transpose_origin }) {
  const refuse = (why) => new Error(`[floor_stack] CODING VIOLATION (Law 13): "${name}" ${why} Pieces: ${Object.keys(pieces).join(', ')}.`);
  const parts = [...floors, roof];
  for (const part of parts) if (!pieces[part]) throw refuse(`names the floor "${part}", which the file does not hold.`);
  if (!floors.length) throw refuse('names no floors.');
  floors.forEach((part, i) => {
    const kind = pieces[part].kind;
    if (kind !== (i === 0 ? 'ground' : 'floor')) throw refuse(`has the ${kind} piece "${part}" as storey ${i + 1}; storey 1 is a ground piece and the rest are upper pieces, or the stair does not meet.`);
  });
  if (pieces[roof].kind !== 'roof') throw refuse(`has "${roof}" as its roof, which is a ${pieces[roof].kind} piece.`);
  const { w, l } = pieces[floors[0]].dimensions;
  const odd = parts.find(part => pieces[part].dimensions.w !== w || pieces[part].dimensions.l !== l);
  if (odd) throw refuse(`stacks "${odd}" on a ${w} x ${l} footprint it does not share.`);

  const h = parts.length * HEIGHT;
  const anchors = [], beds = [], required_air = [], workstations = [], levels = [];
  parts.forEach((part, i) => {
    const piece = pieces[part], y0 = i * HEIGHT;
    for (const a of piece.anchors) anchors.push({ ...a, position: raise(a.position, y0), voxels: a.voxels.map(v => raise(v, y0)) });
    for (const b of piece.beds || []) beds.push({ ...b, id: `bed_${b.foot[0]}_${b.foot[1] + y0}_${b.foot[2]}`, foot: raise(b.foot, y0), head: raise(b.head, y0) });
    for (const p of piece.required_air || []) required_air.push(raise(p, y0));
    for (const s of piece.workstations || []) workstations.push({ ...s, stand: raise(s.stand, y0), targets: s.targets.map(p => raise(p, y0)) });
    levels.push({ id: part, name: piece.title, min: y0, max: y0 + HEIGHT - 1 });
  });
  return {
    name, description: `${floors.length} floors and a roof: ${parts.join(', ')}`,
    dimensions: { w, h, l, yMin: 0, yMax: h - 1 },
    build_center: { x: 0, y: 0, z: 0 }, transpose_origin, transpose_origin_cell: transpose_origin,
    anchors, unassigned_voxels: [],
    design_intent: { title, beds, installed_beds: beds.length, bed_capacity: beds.length, required_air, floors: levels, roof_from: floors.length * HEIGHT, recipe: { floors, roof }, workstations },
  };
}

module.exports = { stackFloors, HEIGHT };
