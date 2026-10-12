/*
warnings_lens.js — every warning in the run, folded by the unit that raised it and by the shape of its words.

A warning's numbers (coordinates, counts, seconds, ids) change from line to line while its sentence stays the
same, so the shape is the sentence with every number written as N. Two warnings of one shape are one
finding said twice; the count of shapes is how many different things the run had to say.

── WHERE THE FACTS COME FROM ─────────────────────────────────────────────────────────────────────────
  ⚠️ [TAG] text   every line `trace_read.parseLine` reads at level 'warn'.
*/

'use strict';

// The fold is the foreman's too, so a live fleet and a finished run count the same shapes (Law 16).
const { shapeOf, foldLine } = require('../js_kernel/utils/warning_shape');

function reduceWarnings({ seg = [] } = {}) {
    const byTag = new Map();   // tag → { count, bots:Set, shapes:Map(shape → count) }
    let total = 0;
    for (const l of seg) {
        if (l.level !== 'warn') continue;
        const { unit: tag, shape } = foldLine(l.raw);
        const row = byTag.get(tag) || { count: 0, bots: new Set(), shapes: new Map() };
        row.count++;
        if (l.bot) row.bots.add(l.bot);
        row.shapes.set(shape, (row.shapes.get(shape) || 0) + 1);
        byTag.set(tag, row);
        total++;
    }
    return { total, byTag };
}

function runWarnings({ seg = [], verbose = false } = {}) {
    const out = require('./data_out');
    const r = reduceWarnings({ seg });
    const tags = [...r.byTag.entries()].sort((a, b) => b[1].count - a[1].count);

    out.section('warnings');
    out.kv('warnings', r.total);
    out.kv('units_raising', tags.length);
    out.kv('distinct_shapes', tags.reduce((n, [, t]) => n + t.shapes.size, 0));

    out.section('warnings_by_unit');
    out.table(['unit', 'warnings', 'share_pct', 'bots', 'shapes'],
        tags.map(([tag, t]) => [tag, t.count, r.total ? (100 * t.count / r.total).toFixed(1) : '0', t.bots.size, t.shapes.size]));

    out.section('warnings_by_shape');
    const perTag = verbose ? Infinity : 3;
    const rows = [];
    for (const [tag, t] of tags) {
        const shapes = [...t.shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, perTag);
        for (const [shape, n] of shapes) rows.push([tag, n, shape]);
    }
    out.table(['unit', 'warnings', 'shape'], rows);
}

module.exports = { reduceWarnings, runWarnings, shapeOf };
