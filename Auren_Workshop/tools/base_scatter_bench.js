'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/base_scatter_bench.js');
// tool: base_scatter_bench — sites every crew's base on every saved snapshot, with no server, the way the foreman's
// survey does: each structure on its own ground, then the lights of a crew that lights its base.
//
// Drives the REAL survey (lock_all_buildspots.run, dry) over every snapshot voxel_snapshot_store holds, from the person
// spot each snapshot was captured on, for the homesteader and for the builder round each downloaded build. Prints the
// survey's own report line by line and a table: which bases sited, and for a lit base how many torch posts its pad
// holds (base_layout.paintLights).
//
// Usage (developer mode, no server):
//   node Auren_Workshop/tools/base_scatter_bench.js [--crew=homesteader,builder] [--build=house_from_abfielder,overgrown_survival_castle] [--quiet]

const paths = require('../workshop_paths');
paths.registerAliases();
process.env.BOT_ID = process.env.BOT_ID || 'base_scatter_bench';
const moduleHomes = require('@utils/node_module_homes');
for (const d of moduleHomes.bootstrapModulePath()) module.paths.unshift(d);

const store = require('./voxel_snapshot_store');

const args = process.argv.slice(2);
const listArg = (k) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3).split(',') : null; };
const say = m => console.log(m);

async function main() {
  const cfg = require('@thinking/architect_config');
  const crews = listArg('crew') || [cfg.BOT_MODES.HOMESTEADER, cfg.BOT_MODES.BUILDER];
  const builds = listArg('build') || Object.keys(cfg.BUILDER_BUILDS);
  for (const b of builds) if (!cfg.BUILDER_BUILDS[b]) { say(`base_scatter_bench: '${b}' is no BUILDER_BUILDS row (${Object.keys(cfg.BUILDER_BUILDS).join(', ')}).`); return 1; }
  const snaps = store.listSnapshots();
  if (!snaps.length) { say(`base_scatter_bench: no snapshots in ${store.SNAPSHOT_DIR} — capture some with voxel_snapshot.js capture.`); return 1; }
  const lock = require('../../action_fragments.js/lock_all_buildspots');
  const rows = [];
  for (const snap of snaps) {
    const bot = store.loadSnapshot(snap.name);
    global.bot = bot;
    const p = bot.snapshot.person || bot.snapshot.body;
    const origin = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    bot.entity = { position: origin };
    const name = snap.header.label || snap.name;
    for (const crew of crews) {
      for (const build of (crew === cfg.BOT_MODES.BUILDER ? builds : [cfg.CREW_BUILD[crew]])) {
        const who = build ? `${crew}/${build}` : crew;
        const t0 = Date.now();
        const r = await lock.run(bot, { dryRun: true, species: crew, build, origin, unlockedWorld: true });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const pad = r.ok ? (r.site || []).find(row => row.candidate.lights) : null;
        rows.push({ snap: name, who, ok: r.ok, posts: pad ? pad.candidate.lights.posts.length : null, loose: (r.report || []).filter(l => / instead\.$/.test(l)).length });
        say(`${name} ${who}: ${r.ok ? 'SITED' : 'NOT SITED'} in ${secs}s${r.ok ? '' : ` · ${(r.problems || ['transient']).join(' | ')}`}`);
        if (!args.includes('--quiet')) for (const line of r.report || []) say(`    ${line.split('\n')[0]}`);
      }
    }
  }
  say('');
  say('sited  per snapshot (posts for a lit base, ~n supports sited loose, ✗ not sited)   base');
  for (const who of [...new Set(rows.map(r => r.who))]) {
    const of = rows.filter(r => r.who === who);
    const cells = of.map(r => `${r.snap}:${r.ok ? `${r.posts ?? '✓'}${r.loose ? `~${r.loose}` : ''}` : '✗'}`);
    say(`${of.filter(r => r.ok).length}/${of.length}    ${cells.join('  ').padEnd(60)} ${who}`);
  }
  return 0;
}

main().then(code => process.exit(code), (e) => { console.error(e); process.exit(1); });
