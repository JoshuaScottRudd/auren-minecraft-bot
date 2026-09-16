'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/wheat_ab_test.js');
// tool: wheat_ab_test — run the wheat-siting scanner against every saved voxel snapshot, on the same ground each time.
// No server, no client, no crew: snapshots are loaded by voxel_snapshot_store and the scanner is the fleet's own,
// called the way a crew would call it, from the person spot the snapshot was captured on.
//
// THE ARMS. One today: the trident (wheat_trident_scanner), chosen 2026-09-15 after the bank farm and the bridge
// island lost (bugsquashing §2, §3). A challenger is added to ARMS and the table compares it on the same columns.
//
// WHAT IS MEASURED, per snapshot: whether a full field was sited; the view's capacity; blocks placed and dug; how far
// the nearest anchor prime is from the person and what the route there costs; how many tines; the ROUTE CENSUS — of
// the anchor primes of the view's capacity tines, how many the fleet's own route search (walking only) reaches from
// the person, and how many of the view's plots that disqualifies.
// Every tine, anchor and build step of the chosen field is written to fleet_logs/wheat_ab_test.json.
//
// Usage (developer mode):
//   node Auren_Workshop/tools/wheat_ab_test.js [--snapshots=all|name,name]
// Exit: 0 ran · 1 no snapshot to run on.

const fs = require('fs');
const path = require('path');
const paths = require('../workshop_paths');
paths.registerAliases();
process.env.BOT_ID = process.env.BOT_ID || 'wheat_ab_test';

const store = require('./voxel_snapshot_store');
const { scanWheatTrident, describeTrident } = require('@utils/wheat_trident_scanner');

const args = process.argv.slice(2);
const opt = (k, fallback) => { const hit = args.find(a => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : fallback; };
const say = m => console.log(m);
const pad = (v, n) => String(v).padEnd(n);

const ARMS = [
  {
    name: 'trident',
    run: (bot, origin) => scanWheatTrident(bot, { origin, combatGate: false, reachCensus: true }),
    describe: describeTrident,
    metrics: s => ({
      full: s.found, capacity: `${s.capacityPlots} plots`, placed: s.found ? s.blocksPlaced : 0, dug: 0,
      anchorDist: s.found ? Math.round(s.distFromOrigin) : null, pieces: s.tines.length,
      route: s.census ? `${s.census.reachable}/${s.census.primes}` : '-', lostTines: s.census ? `${s.census.lostPlots}/${s.capacityPlots}` : '-',
      skipped: s.skippedNoRoute.length, secs: s.elapsedMs / 1000,
      extra: `rows ${s.tines.map(t => t.rows).join('+')}, route cost ${s.tines.map(t => Math.round(t.routeCost)).join('+')}, longest ${s.longestTine}`,
    }),
    dump: s => ({ found: s.found, tines: s.tines, skippedNoRoute: s.skippedNoRoute, census: s.census }),
  },
];

async function main() {
  const all = store.listSnapshots();
  const wanted = opt('snapshots', 'all');
  const chosen = wanted === 'all' ? all : wanted.split(',').map(w => all.find(s => s.name === w || s.header.label === w)).filter(Boolean);
  if (!chosen.length) { say(`wheat_ab_test: no snapshots to run (${all.length} saved). Capture with voxel_snapshot.js capture --near=X,Z.`); return 1; }

  const rows = [], dump = [];
  for (const snap of chosen) {
    const bot = store.loadSnapshot(snap.name);
    bot.inventory = { items: () => [] };                 // the route search reads it; a walking-only search holds nothing
    const h = bot.snapshot;
    const origin = { x: h.person.x, y: h.person.y, z: h.person.z };
    say(`\n════ ${snap.name} — seed ${h.seed}, ${h.chunkCount} chunks, person (${origin.x},${origin.y},${origin.z}) in ${h.person.biome} ════`);
    const entry = { snapshot: snap.name, seed: h.seed, person: h.person };
    for (const arm of ARMS) {
      const s = await arm.run(bot, origin);
      say(`── ${arm.name}\n${arm.describe(s)}`);
      rows.push({ snap: h.label || snap.name, biome: h.person.biome, arm: arm.name, ...arm.metrics(s) });
      entry[arm.name] = arm.dump(s);
    }
    dump.push(entry);
  }

  say('\n════ SUMMARY ════');
  say(`${pad('snapshot', 10)}${pad('biome', 14)}${pad('arm', 9)}${pad('32?', 5)}${pad('capacity', 13)}${pad('placed', 8)}${pad('dug', 5)}` +
    `${pad('prime→person', 14)}${pad('tines', 7)}${pad('primes w/ route', 17)}${pad('plots lost', 13)}${pad('skipped', 9)}${pad('scan s', 8)}notes`);
  for (const r of rows) {
    say(`${pad(r.snap, 10)}${pad(r.biome, 14)}${pad(r.arm, 9)}${pad(r.full ? 'yes' : 'NO', 5)}${pad(r.capacity, 13)}${pad(r.placed, 8)}${pad(r.dug, 5)}` +
      `${pad(r.anchorDist === null ? '-' : `${r.anchorDist}b`, 14)}${pad(r.pieces, 7)}${pad(r.route, 17)}${pad(r.lostTines, 13)}${pad(r.skipped, 9)}${pad(r.secs.toFixed(1), 8)}${r.extra}`);
  }
  const out = paths.fleetLogs('wheat_ab_test.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ rows, snapshots: dump }, null, 1));
  say(`\nevery tine, anchor and build step: ${path.relative(paths.bot(), out)}`);
  return 0;
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
