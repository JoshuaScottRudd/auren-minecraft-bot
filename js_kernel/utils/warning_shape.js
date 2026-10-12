'use strict';
// warning_shape.js — the shape of a warning: the unit that raised it and its sentence with every number written as N.
//
// A warning's numbers (coordinates, counts, seconds, ids) change from line to line while its sentence stays
// the same, so two warnings of one shape are one finding said twice. The foreman folds the live fleet's
// warnings by this, and the warnings lens folds a finished run's by it, so both count the same things (Law 16).

const TAG_RE = /⚠️ \[([^\]]+)\]\s*(.*)$/;
const SHAPE_LENGTH = 160;

// The sentence with its numbers taken out: coordinates, ids joined by | and plain numbers each become N.
function shapeOf(text) {
  return text
    .replace(/\(-?\d+(\.\d+)?, ?-?\d+(\.\d+)?, ?-?\d+(\.\d+)?\)/g, '(N)')
    .replace(/-?\d+(\|-?\d+)+/g, 'N')
    .replace(/-?\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

// foldLine(line) → { unit, shape } for one warning line as its bot wrote it.
function foldLine(line) {
  const m = line.match(TAG_RE);
  return { unit: m ? m[1] : '(untagged)', shape: shapeOf(m ? m[2] : line).slice(0, SHAPE_LENGTH) };
}

module.exports = { shapeOf, foldLine };
