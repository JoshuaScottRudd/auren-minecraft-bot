// Auren_Bot/monitoring/site_lens.js
// --site: where the base was sited, and what every landing refused. Reads the foreman's own stream: the random landing's
// lines (foreman/utils/startup_steps.js: each landing rolled, each refused with its cause) and the base-layout survey's
// report (action_fragments.js/lock_all_buildspots.js): each structure found, sited beside another than the one it serves,
// or not found, and the base's lights painted (siteLights).
// Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --site

'use strict';

const out = require('./data_out');

const ROLLED_RE = /landing (\d+) of (\d+): rolled \((-?\d+),(-?\d+)\), (\d+) blocks from the usual spot/;
const KEPT_RE = /a random landing that holds the base is found — \((-?\d+),(-?\d+),(-?\d+)\), (\S+), \d+ blocks from the usual spot .* on roll (\d+) of (\d+)/;
const REFUSED_RE = /landing (\d+) refused: ([^\n]*)/;
// The step's retry line wraps a refusal in brackets and says when it tries again.
const RETRY_TAIL_RE = /\)? — trying again.*$|\)$/;
// One structure sited (a building, a support, the builder's shaft mouth), one sited beside another than the one it
// serves, one not found, and the base's lights painted or left dark.
const FOUND_RE = /^\s*(\S+): FOUND (?:mouth )?at \((-?\d+),(-?\d+),(-?\d+)\)/;
const LOOSE_RE = /^\s*(\S+): (?:no spot|nothing level) beside (\S+); sited beside (\S+) instead\./;
const FACING_RE = /, turn (\d), standby side (\w+)/;   // a pen's turn and the side its standby cell lies on
const NOT_FOUND_RE = /^\s*(\S+): ✗ (?:NOT FOUND )?([^\n]*)/;
const LIT_RE = /^\s*(\S+): LIT (\d+)x(\d+) area from \((-?\d+),(-?\d+)\), (\d+) stand cell\(s\), (\d+) torch post\(s\) \((\d+) on the (\d+)-block grid, (\d+) where it left dark\), in ([\d.]+)s\./;
// The survey's report rides on its summary line, one structure per line.
const LINES_RE = /\n/;
// The step's last refusal, which restates every landing's.
const FINAL_RE = /BASE NOT SITED/;
// Each landing's refusal inside that last one; the last landing's is said nowhere else.
const FINAL_LANDING_RE = /landing (\d+) \((-?\d+),(-?\d+)\): ([^·]*?)(?= · landing \d+ \(|\. Each landing's survey report|$)/g;
// The line breaks a long refusal is wrapped at.
const WRAP_RE = /\n\s*/g;
function reduceSite({ foreman = [] } = {}) {
  const landings = new Map();
  const sited = new Map();     // structure → { origin, beside }
  const missed = new Map();    // structure → why
  let lights = null;
  let kept = null;
  const landing = (k) => { if (!landings.has(k)) landings.set(k, { n: k, x: null, z: null, out: null, refused: null }); return landings.get(k); };
  for (const l of foreman) {
    const raw = l.raw || '';
    let m = ROLLED_RE.exec(raw);
    if (m) Object.assign(landing(+m[1]), { of: +m[2], x: +m[3], z: +m[4], out: +m[5] });
    m = REFUSED_RE.exec(raw);
    if (m && !FINAL_RE.test(raw)) landing(+m[1]).refused = m[2].replace(RETRY_TAIL_RE, '');
    if (FINAL_RE.test(raw)) {
      for (const fm of raw.replace(WRAP_RE, ' ').matchAll(FINAL_LANDING_RE)) { const r = landing(+fm[1]); if (!r.refused) r.refused = fm[4]; }
    }
    m = KEPT_RE.exec(raw);
    if (m) kept = { x: +m[1], y: +m[2], z: +m[3], biome: m[4], roll: +m[5] };
    const loose = new Map();
    for (const line of raw.split(LINES_RE)) {
      if ((m = LOOSE_RE.exec(line))) { loose.set(m[1], m[3]); continue; }
      if ((m = LIT_RE.exec(line))) { lights = { proofing: m[1], w: +m[2], l: +m[3], from: `${m[4]},${m[5]}`, stands: +m[6], posts: +m[7], grid: +m[8], every: +m[9], added: +m[10], secs: +m[11] }; continue; }
      if ((m = FOUND_RE.exec(line))) {
        const f = FACING_RE.exec(line);
        sited.set(m[1], { origin: `${m[2]},${m[3]},${m[4]}`, beside: loose.get(m[1]) || null, turn: f ? f[1] : null, standby: f ? f[2] : null });
        missed.delete(m[1]);
        continue;
      }
      if ((m = NOT_FOUND_RE.exec(line))) missed.set(m[1], m[2]);
    }
  }
  return { landings: [...landings.values()].sort((a, b) => a.n - b.n), sited, missed, lights, kept };
}

function runSite({ foreman = [], traceName = '?' } = {}) {
  const { landings, sited, missed, lights, kept } = reduceSite({ foreman });
  out.kv('lens', 'site');
  out.kv('record', traceName);
  out.section('base_site');
  out.kv('landings_rolled', landings.length);
  out.kv('landing_kept', kept ? kept.roll : null);
  out.kv('landing_spot', kept ? `${kept.x},${kept.y},${kept.z}` : null);
  out.kv('landing_biome', kept ? kept.biome : null);
  out.kv('structures_sited', sited.size);
  out.kv('structures_sited_loose', [...sited.values()].filter(v => v.beside).length);
  out.kv('lights_proofing', lights ? lights.proofing : null);
  out.kv('lights_area', lights ? `${lights.w}x${lights.l}` : null);
  out.kv('lights_from', lights ? lights.from : null);
  out.kv('lights_stand_cells', lights ? lights.stands : null);
  out.kv('torch_posts', lights ? lights.posts : null);
  out.kv('torch_posts_grid', lights ? lights.grid : null);
  out.kv('torch_grid_every', lights ? lights.every : null);
  out.kv('torch_posts_dark_fill', lights ? lights.added : null);
  out.section('structures');
  out.table(['structure', 'origin', 'sited_beside', 'turn', 'standby_side'], [...sited.entries()].map(([k, v]) => [k, v.origin, v.beside || '—', v.turn ?? '—', v.standby || '—']));
  out.section('not_found');
  out.table(['structure', 'why'], [...missed.entries()].map(([k, v]) => [k, v]));
  out.section('landings');
  out.table(['landing', 'rolled_x', 'rolled_z', 'blocks_out', 'refused'], landings.map(r => [r.n, r.x, r.z, r.out, r.refused || '—']));
  return { landings, sited, missed, lights, kept };
}

module.exports = { reduceSite, runSite };
