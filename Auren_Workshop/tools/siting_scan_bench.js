'use strict';
// tool: siting_scan_bench — how long does finding a blueprint location actually take, before and after?
// Architect 2026-08-04: "especially test the setting a blueprint location. normally it takes 30 seconds
// or more to set the intial blueprint locations. id like to see how much time we save."
//
// Drives the REAL siting sweep — site_geometry.ringScan + evaluateOpenBox, the same functions
// find_buildingspot.locate composes — over the SAME cells, three times, differing in one thing: the reader.
//   A (before) a blockAt-per-cell reader, exactly what find_buildingspot carried until 2026-08-04
//   B (after)  the declared-needs reader it carries now, needs:['type']
//   C (v2)     the 2026-08-04 prototype: column memo, no per-read allocation, borrowed shell
// Arm C was added when the Architect asked why the bot cannot keep a live map instead of re-finding the
// world on every read. It does keep one — a held reference to mineflayer's own live chunk column — and
// this is the sweep that says what that is worth on the fleet's most expensive scan.
//
// VERDICT AGREEMENT IS THE GATE. Every candidate cell's accept/reject AND its rejection reason are
// compared. A faster sweep that sites the base somewhere else has not saved 20 seconds, it has moved the
// base — and a timing printed beside a changed decision would be a true number certifying a false claim
// (Law 25). One divergence voids the run.
//
// WHAT IT CANNOT PROVE (Law 25): this measures the SCAN. `locate` also loads blueprint dims, reads HQ,
// checks spacing against existing footprints and writes the result; none of that is here, so the
// fleet-visible "30 seconds" includes work this bench does not touch. The pacer is also disabled in
// both arms (`pace: null`) — with it on, both arms would be dominated by identical yields and the
// comparison would measure the throttle rather than the reader. Real elapsed time in a live run is
// therefore LONGER than either number here; the RATIO is the finding.
//
// Usage (server must be running):
//   NODE_PATH=MinecraftServer/node_modules node_portable/node-v22.13.1-win-x64/node.exe \
//     Auren_Workshop/tools/siting_scan_bench.js --radius=48 --size=11 --height=5

const path = require('path');
require('../workshop_paths').registerAliases();

const mineflayer = require('mineflayer');
const Vec3 = require('vec3');
const siteGeometry = require('@utils/site_geometry');
const { makeVoxelReader } = require('@utils/voxel_reader');
const { makeVoxelReaderV2 } = require('./voxel_reader_v2_prototype');

const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find(a => a.startsWith(`--${k}=`)); return h ? h.split('=')[1] : d; };
const RADIUS = Number(arg('radius', 48));
const SIZE   = Number(arg('size', 11));      // headframe-scale footprint
const HEIGHT = Number(arg('height', 5));
const STEP   = Number(arg('step', 2));
const REPEAT = Number(arg('repeat', 2));

const log = (t, m) => console.log(`[${t}] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One sweep. Returns every cell's verdict in visit order plus the elapsed time and read count.
async function sweep(reader, origin) {
    const verdicts = [];
    const t0 = process.hrtime.bigint();
    const res = await siteGeometry.ringScan(reader, {
        origin, step: STEP, minRadius: 0, maxRadius: RADIUS,
        pace: null,           // see header — the throttle would dominate both arms identically
        all: true,
    }, (cx, cz) => {
        // ringScan's contract is evaluate(x, z) — it does NOT pass the reader through, so the arm under
        // test comes from this closure. Verdict field is `valid` (ringScan itself branches on it).
        const v = siteGeometry.evaluateOpenBox(reader, cx, cz, origin.y, { size: SIZE, height: HEIGHT });
        verdicts.push(`${cx},${cz}:${v && v.valid ? 'OK' : `no(${v && v.reason})`}`);
        return v;
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, verdicts, checked: res && res.checked, reads: reader.stats.reads };
}

async function main() {
    const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'Siting_AB', version: '1.21.5', auth: 'offline' });
    bot.on('error', e => { log('boot', `socket error: ${e.message}`); process.exit(1); });
    bot.on('kicked', r => { log('boot', `kicked: ${JSON.stringify(r)}`); process.exit(1); });
    await new Promise(r => bot.once('spawn', r));
    log('boot', 'spawned — waiting for chunks…');
    await sleep(6000);

    const origin = bot.entity.position.floored();
    log('boot', `origin (${origin.x},${origin.y},${origin.z})  footprint ${SIZE}x${SIZE}x${HEIGHT}  radius ${RADIUS} step ${STEP}`);

    // ARM A — what find_buildingspot's readerFor was before today: a blockAt per cell.
    let aReads = 0;
    const before = {
        stats: { get reads() { return aReads; }, set reads(v) { aReads = v; } },
        blockAt: (x, y, z) => { aReads++; return bot.blockAt(new Vec3(x, y, z)); },
    };
    // ARM B — what it is now.
    const after = makeVoxelReader(bot, { needs: ['type'] });
    log('boot', `arm B reader fast=${after.fast}` + (after.fast ? '' : ` (UNMET: ${after.unmetNeeds}) — the comparison is void`));
    if (!after.fast) process.exit(1);

    // ARM C — the v2 prototype (2026-08-04): column memo, no per-read allocation, borrowed shell.
    // BORROWED IS LEGAL HERE AND ILLEGAL IN A*, and the difference is worth stating where it is used:
    // site_geometry reads `.name`/`.boundingBox` off the block immediately and retains only strings
    // (`{ y, name: b.name }`), so a shell that is only valid until the next read is a true answer for the
    // whole time this caller looks at it. A* keeps `floorBlock.position` across three further reads and
    // would have it rewritten underneath — which is why borrowing is opt-in per caller, never a default.
    const proto = makeVoxelReaderV2(bot, { version: bot.version });
    if (!proto.fast) { log('boot', 'arm C fell to its slow path — the comparison is void'); process.exit(1); }
    const armC = { stats: proto.stats, blockAt: (x, y, z) => proto.borrowBlockAt(x, y, z), resetStats: () => proto.resetStats() };

    // Warm all three once and discard: the first sweep pays JIT for site_geometry's whole graph.
    await sweep(before, origin); aReads = 0;
    await sweep(after, origin); after.resetStats();
    await sweep(armC, origin); proto.resetStats();

    let aMs = 0, bMs = 0, cMs = 0, aR = 0, bR = 0, cR = 0, mismatch = 0, checked = 0, firstBad = '';
    for (let i = 0; i < REPEAT; i++) {
        aReads = 0; const A = await sweep(before, origin); aMs += A.ms; aR += A.reads;
        after.resetStats(); const B = await sweep(after, origin); bMs += B.ms; bR += B.reads;
        proto.resetStats(); const C = await sweep(armC, origin); cMs += C.ms; cR += C.reads;
        checked = A.checked;
        // Every arm against arm A, cell by cell, reason by reason.
        for (const [label, X] of [['B', B], ['C', C]]) {
            if (A.verdicts.length !== X.verdicts.length) { mismatch++; firstBad = firstBad || `${label}: verdict count ${A.verdicts.length} vs ${X.verdicts.length}`; continue; }
            for (let k = 0; k < A.verdicts.length; k++) {
                if (A.verdicts[k] !== X.verdicts[k]) { mismatch++; firstBad = firstBad || `${label}: ${A.verdicts[k]} vs ${X.verdicts[k]}`; }
            }
        }
        log('sweep', `pass ${i + 1}/${REPEAT}: A ${A.ms.toFixed(0)} ms (${A.reads} reads) | B ${B.ms.toFixed(0)} ms (${B.reads}) | C ${C.ms.toFixed(0)} ms (${C.reads}) | ${A.verdicts.length} cells judged`);
    }

    console.log('\n──────── RESULT ────────');
    if (mismatch > 0) {
        console.log(`VERDICT DIVERGENCE on ${mismatch} cells — first: ${firstBad}. NO timing reported.`);
        console.log('A faster sweep that sites the base elsewhere has not saved time; it has moved the base.');
        proto.dispose(); bot.quit(); process.exit(1);
    }
    console.log(`every siting verdict IDENTICAL across all three arms, ${REPEAT} passes (${checked} candidate columns judged per sweep)`);
    console.log(`  voxel reads   A ${(aR / REPEAT).toFixed(0)}/sweep   B ${(bR / REPEAT).toFixed(0)}   C ${(cR / REPEAT).toFixed(0)}   (identical questions — the reads got cheaper, not fewer)`);
    console.log(`  scan time     A ${(aMs / REPEAT).toFixed(0)} ms   B ${(bMs / REPEAT).toFixed(0)} ms   C ${(cMs / REPEAT).toFixed(0)} ms`);
    console.log(`  speedup       B over A ${(aMs / bMs).toFixed(2)}x   |   C over B ${(bMs / cMs).toFixed(2)}x   |   C over A ${(aMs / cMs).toFixed(2)}x`);
    console.log(`  saved by C vs today's fleet: ${((bMs - cMs) / REPEAT / 1000).toFixed(2)} s per siting sweep`);
    console.log(`  column memo   ${proto.stats.columnHits} hits / ${proto.stats.columnMisses} misses ` +
        `(${(100 * proto.stats.columnHits / Math.max(1, proto.stats.columnHits + proto.stats.columnMisses)).toFixed(1)}% of reads reused the held column)`);
    console.log(`  state ids the fast path had to classify: ${after.statesSeen} (paid once, at first sight)`);
    proto.dispose();
    bot.quit();
    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
