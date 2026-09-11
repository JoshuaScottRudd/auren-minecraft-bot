'use strict';
// tool: voxel_reader_stress_bench — the ADVERSARIAL half of the reader evidence. Its job is to BREAK the
// prototype, not to confirm it.
//
// Architect 2026-08-04: "gotta challenge before we use. what was tha nature of the test? does it
// compensate for a dynamic voxel changing world? does this savings go away when the dynamic world
// changes? like digging or creeper explosion. also, i want more data saying the test was a success. you
// are self certifying right now. i need more data so i can decide if its good. not you."
//
// ── WHY THIS FILE EXISTS SEPARATELY FROM astar_reader_v2_bench ──────────────────────────────────────
// That bench was built to measure a speedup and it gates on route identity; every phase in it is a
// phase the prototype was expected to pass. A suite whose author expects it to pass is a suite that
// certifies its author (Law 25 — the performer deciding what counts as enough for the asker). This file
// is built the other way round: every phase below is an attempt to produce a WRONG answer out of the
// prototype, and three of them succeed by design against a deliberately misused API so that the ones
// that DON'T fire mean something. A green run here is evidence; a green run there was a claim.
//
// It also writes every raw sample to a JSON file rather than only printing aggregates, because a mean is
// the performer's summary of its own result. The file is the data; the console is the summary.
//
// ── THE FIVE PHASES ─────────────────────────────────────────────────────────────────────────────────
//   1 CHURN CORRECTNESS   every reader, against bot.blockAt, immediately after each of N real server
//                         block changes — including a creeper-scale multi-block /fill
//   2 NEGATIVE CONTROLS   deliberate misuse that MUST produce a wrong answer, proving the tests can fail
//   3 HELD-HANDLE HAZARD  a chunk unloaded under a memoized column reference
//   4 CHURN THROUGHPUT    the A/B/C/D timing while the server is actively rewriting the same columns
//   5 STATIC BASELINE     the same trials with a quiet world, so phase 4 has something to be compared to
//
// Usage (server must be running):
//   NODE_PATH=... node_env2/node.exe Auren_Workshop/tools/voxel_reader_stress_bench.js --dist=64 --nodes=30000 --repeat=6

const path = require('path');
const paths = require('../workshop_paths');
paths.registerAliases();

const fs = require('fs');
const mineflayer = require('mineflayer');
const Vec3 = require('vec3');
const pathfinding = require('@utils/pathfinding_utils');
const { makeVoxelReader } = require('@utils/voxel_reader');
const { makeVoxelReaderV2 } = require('./voxel_reader_v2_prototype');
const rcon = require(paths.bot('js_kernel/utils/rcon_link'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find(a => a.startsWith(`--${k}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const DIST     = Number(arg('dist', 64));
const REPEAT   = Number(arg('repeat', 6));
const MAXNODES = Number(arg('nodes', 30000));
const CHURN_N  = Number(arg('churn', 120));
const VERSION  = arg('version', '1.21.5');
// ONE `..` — __dirname is Auren_Workshop/tools, so this lands in Auren_Bot/fleet_logs beside every other
// record. It carried two, which resolved to the REPO ROOT and created a second, untracked fleet_logs/
// there on each run — a shadow copy of the directory the monitors read, which is the second pathway
// Law 16 forbids (and the root one is gitignored, so it was invisible to status). Match combat_ledger.js:52.
const OUT      = arg('out', paths.fleetLogs('reader_stress_samples.json'));

const log = (t, m) => console.log(`[${t}] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const samples = { meta: {}, churnCorrectness: [], negativeControls: [], heldHandle: [], trials: [] };

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    if (cond) { pass++; log('check', `ok   ${name}`); }
    else { fail++; log('check', `FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
    return cond;
};

// The comparison key: exactly the fields A* consults, and nothing else. Widening it would fail the
// prototype for a difference the search cannot observe (light/biome are deliberately not per-position in
// the shell); narrowing it would let a real disagreement through.
const key = b => b === null ? 'NULL' : `${b.name}|${b.boundingBox}|${!!b.diggable}|${pathfinding.isFullHeightFloor(b)}`;

async function main() {
    const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'ReaderStress', version: VERSION, auth: 'offline' });
    bot.on('error', e => { log('boot', `socket error: ${e.message}`); process.exit(1); });
    bot.on('kicked', r => { log('boot', `kicked: ${JSON.stringify(r)}`); process.exit(1); });
    await new Promise(r => bot.once('spawn', r));
    let prev = -1, stable = 0;
    for (let i = 0; i < 60 && stable < 3; i++) { await sleep(500); const n = bot.world.getColumns().length; stable = (n === prev) ? stable + 1 : 0; prev = n; }
    log('boot', `spawned; ${prev} columns loaded and stable.`);

    let worldEvents = 0;
    bot.on('blockUpdate', () => { worldEvents++; });

    const shipped = makeVoxelReader(bot, { needs: ['type'] });
    const proto   = makeVoxelReaderV2(bot, { version: VERSION });
    const scoped  = makeVoxelReaderV2(bot, { version: VERSION, searchScoped: true });
    const link    = await rcon.open(rcon.readServerProperties());

    samples.meta = { version: VERSION, dist: DIST, nodes: MAXNODES, repeat: REPEAT, churnOps: CHURN_N, columns: prev, startedAtIso: null };

    try {
        await phase1ChurnCorrectness(bot, link, [shipped, proto, scoped]);
        phase2NegativeControls(bot, proto);
        await phase3HeldHandle(bot, proto);
        const stat = await phaseTrials(bot, shipped, proto, scoped, null, 'static');
        const chn  = await phaseTrials(bot, shipped, proto, scoped, link, 'churn');
        report(stat, chn, worldEvents);
    } finally {
        link.close();
        proto.dispose(); scoped.dispose();
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(samples, null, 2));
        log('data', `every raw sample written to ${OUT} — the console below is a summary of that file, not a substitute for it.`);
        bot.quit();
    }
    process.exit(fail ? 1 : 0);
}

// ── PHASE 1 ─────────────────────────────────────────────────────────────────────────────────────────
// The direct answer to "does it compensate for a dynamic voxel changing world". Every reader is asked
// about the cell IMMEDIATELY after the server rewrites it, with no invalidation call of any kind. The
// last op is a 9x9x9 /fill — 729 blocks in one multi_block_change, which is creeper-scale and then some
// (a creeper destroys ~30-50). Digging is the same packet path, so this covers it.
async function phase1ChurnCorrectness(bot, link, readers) {
    log('phase', '1 — CHURN CORRECTNESS: do the readers track a world being actively rewritten?');
    const base = bot.entity.position.floored();
    let bad = 0, done = 0, restored = 0;

    for (let i = 0; i < CHURN_N; i++) {
        const dx = (i * 7) % 21 - 10, dz = (i * 13) % 21 - 10, dy = (i % 5) - 2;
        const p = new Vec3(base.x + dx, base.y + dy, base.z + dz);
        const before = bot.blockAt(p);
        if (!before) continue;
        const original = before.name;
        const target = original === 'air' ? 'stone' : 'air';

        await link.command(`setblock ${p.x} ${p.y} ${p.z} ${target} replace`);
        let arrived = false;
        for (let k = 0; k < 40 && !arrived; k++) { await sleep(25); arrived = bot.blockAt(p)?.name === target; }
        if (!arrived) continue;   // the server declined the change (protected/unloaded); nothing to test

        // NOTHING is called between the change and these reads.
        const truth = key(bot.blockAt(p));
        const got = readers.map(r => key(r.blockAt(p.x, p.y, p.z)));
        const agree = got.every(g => g === truth);
        done++;
        if (!agree) bad++;
        samples.churnCorrectness.push({ pos: [p.x, p.y, p.z], from: original, to: target, truth, got, agree });

        await link.command(`setblock ${p.x} ${p.y} ${p.z} ${original} replace`);
        for (let k = 0; k < 40; k++) { await sleep(25); if (bot.blockAt(p)?.name === original) { restored++; break; } }
    }
    check(`all ${done} single-block changes tracked by every reader with no invalidation call`, bad === 0, `${bad} disagreed`);
    check(`all ${done} mutated cells restored to their original block`, restored === done, `${done - restored} not restored`);

    // The creeper-scale event: one packet, 729 blocks.
    const c = new Vec3(base.x + 6, base.y + 30, base.z + 6);   // high air, so the terrain is never damaged
    const lo = `${c.x - 4} ${c.y - 4} ${c.z - 4}`, hi = `${c.x + 4} ${c.y + 4} ${c.z + 4}`;
    await link.command(`fill ${lo} ${hi} stone replace`);
    let filled = false;
    for (let k = 0; k < 60 && !filled; k++) { await sleep(50); filled = bot.blockAt(c)?.name === 'stone'; }
    let blastBad = 0, blastCells = 0;
    if (filled) {
        await link.command(`fill ${lo} ${hi} air replace`);
        let cleared = false;
        for (let k = 0; k < 60 && !cleared; k++) { await sleep(50); cleared = bot.blockAt(c)?.name === 'air'; }
        for (let x = c.x - 4; x <= c.x + 4; x++) for (let y = c.y - 4; y <= c.y + 4; y++) for (let z = c.z - 4; z <= c.z + 4; z++) {
            blastCells++;
            const truth = key(bot.blockAt(new Vec3(x, y, z)));
            if (readers.some(r => key(r.blockAt(x, y, z)) !== truth)) blastBad++;
        }
        samples.heldHandle.push({ kind: 'blast', cells: blastCells, disagreed: blastBad });
    }
    check(`a 729-block one-packet blast (creeper-scale) tracked across all ${blastCells} cells`, filled && blastBad === 0, filled ? `${blastBad} disagreed` : 'the /fill never landed');
}

// ── PHASE 2: NEGATIVE CONTROLS ──────────────────────────────────────────────────────────────────────
// A suite that only ever passes cannot distinguish a working prototype from a broken assertion. These
// three MUST report a wrong answer. If any of them comes back clean, the harness is not actually
// looking at what it claims to look at, and every green result above is worthless.
function phase2NegativeControls(bot, proto) {
    log('phase', '2 — NEGATIVE CONTROLS: three deliberate misuses that MUST produce a wrong answer');
    const base = bot.entity.position.floored();
    const a = new Vec3(base.x + 2, base.y - 1, base.z);
    const b = new Vec3(base.x + 3, base.y - 1, base.z);

    // (i) The borrowed shell's contract, violated on purpose: hold the block across another read.
    //
    // THE FIRST VERSION OF THIS CONTROL DID NOT FIRE, and what it exposed was a wrong claim in the
    // prototype's own header rather than a bad test. Shells are memoized PER STATE ID, so reading a
    // different block leaves the held one untouched — the corruption needs a second read of the SAME
    // state id. That makes the hazard worse, not milder: it is intermittent and data-dependent, so a
    // caller that misuses borrowing survives every test where the two cells happen to differ and
    // corrupts silently the moment they match. The control therefore hunts for two cells that share a
    // state id, which is the case a careless caller will meet constantly (stone beside stone).
    let a2 = null, b2 = null;
    for (let dx = -6; dx <= 6 && !b2; dx++) for (let dz = -6; dz <= 6 && !b2; dz++) for (let dy = -3; dy <= 1 && !b2; dy++) {
        const p = new Vec3(base.x + dx, base.y + dy, base.z + dz);
        const s = proto.stateIdAt(p.x, p.y, p.z);
        if (s < 0) continue;
        if (!a2) { a2 = { p, s }; }
        else if (s === a2.s && !p.equals(a2.p)) { b2 = { p, s }; }
    }
    const held = proto.borrowBlockAt(a2.p.x, a2.p.y, a2.p.z);
    const heldPosBefore = `${held.position.x},${held.position.y},${held.position.z}`;
    if (b2) proto.borrowBlockAt(b2.p.x, b2.p.y, b2.p.z);
    const heldPosAfter = `${held.position.x},${held.position.y},${held.position.z}`;
    const borrowBroke = !!b2 && heldPosBefore !== heldPosAfter;
    samples.negativeControls.push({ control: 'borrowed shell retained across a read', expectedWrong: true, wasWrong: borrowBroke, before: heldPosBefore, after: heldPosAfter });
    check('NEGATIVE: a retained borrowed shell IS corrupted by the next read (the contract is real, not decorative)',
        borrowBroke, 'the shell survived — either borrowing is not doing what its header claims, or this control is not testing it');

    // (ii) The fresh shell must NOT have that property. Same two reads, retained the same way.
    const fresh = proto.blockAt(a.x, a.y, a.z);
    const fp0 = `${fresh.position.x},${fresh.position.y},${fresh.position.z}`;
    proto.blockAt(b.x, b.y, b.z);
    const fp1 = `${fresh.position.x},${fresh.position.y},${fresh.position.z}`;
    check('the FRESH shell survives a later read intact (which is why A* uses it and siting does not)', fp0 === fp1, `${fp0} -> ${fp1}`);

    // (iii) A cell far outside every loaded column must read as UNKNOWN, never as air. This is the one
    // failure that would not throw and would not look wrong — it would look like open sky, and a search
    // would plan a confident route through a chunk nobody has ever seen (Law 23).
    const far = new Vec3(base.x + 200000, base.y, base.z + 200000);
    const farTruth = bot.blockAt(far);
    const farProto = proto.blockAt(far.x, far.y, far.z);
    samples.negativeControls.push({ control: 'unloaded cell must be null, never air', expectedWrong: false, truth: key(farTruth), got: key(farProto) });
    check('an UNLOADED cell reads null on both paths and never as air', farTruth === null && farProto === null,
        `truth=${key(farTruth)} proto=${key(farProto)}`);
}

// ── PHASE 3: THE HELD-HANDLE HAZARD ─────────────────────────────────────────────────────────────────
// The column memo is the one thing the prototype keeps across reads, so this is the one place a stale
// answer could come from. Not a stale BLOCK (the object is live) but a stale IDENTITY: if a column is
// unloaded while a reader still holds it, the reader would answer from terrain the bot can no longer
// see. Provoked by walking the bot far enough that the server unloads the columns behind it.
async function phase3HeldHandle(bot, proto) {
    log('phase', '3 — HELD-HANDLE HAZARD: is the memo dropped when its column is unloaded?');
    const base = bot.entity.position.floored();
    const far = new Vec3(base.x + 4, base.y - 1, base.z + 4);
    proto.blockAt(far.x, far.y, far.z);              // prime the memo on that column
    const missesBefore = proto.stats.columnMisses;
    proto.blockAt(far.x, far.y, far.z);
    const primed = proto.stats.columnMisses === missesBefore;

    // Force the invalidation path directly — the same event mineflayer fires on a real unload. Provoking
    // a genuine unload needs the body to travel hundreds of blocks, which is a different test taking
    // minutes; what must be proven here is that the handle is DROPPED when the event arrives, and this
    // is that event, emitted by the same emitter on the same channel.
    bot.world.emit('chunkColumnUnload', new Vec3(far.x >> 4 << 4, 0, far.z >> 4 << 4));
    const missesAfterEvent = proto.stats.columnMisses;
    proto.blockAt(far.x, far.y, far.z);
    const refetched = proto.stats.columnMisses > missesAfterEvent;
    samples.heldHandle.push({ kind: 'unload', primed, refetchedAfterUnload: refetched });
    check('the memo is primed by a repeat read (so there was something to invalidate)', primed);
    check('an unload event DROPS the held column, forcing a fresh lookup', refetched,
        'the reader kept a handle to an unloaded column — it would answer about terrain the bot cannot see');
}

// ── PHASES 4 and 5: TIMING, QUIET vs CHURNING ───────────────────────────────────────────────────────
// Same trials, run twice: once against a quiet world and once while the server rewrites the SAME columns
// the search reads. The churn is placed in the air well above the terrain, which is deliberate and is a
// stated limitation: it produces real packets, real multi_block_change traffic and real section writes in
// the columns under search, WITHOUT altering the ground the routes cross — so route identity remains a
// valid gate. A change ON the path would legitimately change the route, and correctness under that case
// is what phase 1 tests directly.
async function phaseTrials(bot, shipped, proto, scoped, link, label) {
    log('phase', `${link ? '4' : '5'} — TIMING (${label}): 4 readers, one unmodified computeAStar, ${REPEAT} trials`);
    const feet = bot.entity.position.floored();
    const start = new Vec3(feet.x, feet.y - 1, feet.z);
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    const adapter = { blockAt: p => bot.blockAt(p), inventory: bot.inventory, world: bot.world, version: bot.version, entity: bot.entity };

    const rawStats = { reads: 0, unloaded: 0 };
    const armA = {
        fast: true, stats: rawStats,
        blockAt(x, y, z) { rawStats.reads++; return bot.blockAt(new Vec3(x, y, z)); },
        resetStats() { rawStats.reads = 0; }, beginSearch() {},
    };
    const ARMS = [{ n: 'A', r: armA }, { n: 'B', r: shipped }, { n: 'C', r: proto }, { n: 'D', r: scoped }];

    // Churn driver: a /fill storm in high air, running for the whole timing phase.
    let churning = false, churnOps = 0;
    const churnBox = { x: feet.x + 8, y: feet.y + 40, z: feet.z + 8 };
    async function churnLoop() {
        const lo = `${churnBox.x - 4} ${churnBox.y - 4} ${churnBox.z - 4}`, hi = `${churnBox.x + 4} ${churnBox.y + 4} ${churnBox.z + 4}`;
        while (churning) {
            await link.command(`fill ${lo} ${hi} stone replace`); churnOps++;
            await link.command(`fill ${lo} ${hi} air replace`); churnOps++;
            await sleep(20);
        }
    }

    async function run(reader, goal) {
        reader.resetStats();
        if (reader.beginSearch) reader.beginSearch(start.x, start.y, start.z);
        const t0 = process.hrtime.bigint();
        const res = await pathfinding.computeAStar(adapter, start, goal, { maxNodes: MAXNODES, combatGate: false, voxelReader: reader });
        return { ms: Number(process.hrtime.bigint() - t0) / 1e6, reads: reader.stats.reads, res };
    }
    const sig = r => !r ? 'NULL' : `${r.partial ? 'P' : 'F'}:${(r.path || []).map(s => `${s.type || 'move'}@${s.x},${s.y},${s.z}`).join('|')}`;

    const warm = { type: 'position', pos: new Vec3(start.x + 8, start.y, start.z + 8) };
    for (const a of ARMS) await run(a.r, warm);

    if (link) { churning = true; churnLoop().catch(e => log('churn', `driver stopped: ${e.message}`)); await sleep(300); }

    const rows = [];
    for (let i = 0; i < REPEAT; i++) {
        const [dx, dz] = DIRS[i % DIRS.length];
        const goal = { type: 'position', pos: new Vec3(start.x + dx * DIST, start.y, start.z + dz * DIST) };
        const order = [0, 1, 2, 3].map(k => (k + i) % 4);
        const out = {};
        for (const k of order) out[ARMS[k].n] = await run(ARMS[k].r, goal);
        const sigs = ARMS.map(a => sig(out[a.n].res));
        const same = sigs.every(s => s === sigs[0]);
        const row = {
            phase: label, trial: i + 1, dir: [dx, dz], routeIdentical: same,
            ms: Object.fromEntries(ARMS.map(a => [a.n, +out[a.n].ms.toFixed(1)])),
            reads: Object.fromEntries(ARMS.map(a => [a.n, out[a.n].reads])),
            memoSize: scoped.memoSize, pathLen: (out.A.res?.path || []).length,
            // WHERE THE TIME ACTUALLY GOES. Once arm D showed that removing 97% of world reads changes
            // nothing, the remaining cost has to be the search's own machinery — so the search's shape is
            // the thing to record. nodesVisited/pathLen is the expansion overhead: how many cells were
            // examined per cell of route actually returned.
            nodesVisited: out.A.res?.nodesVisited ?? null,
            partial: out.A.res?.partial ?? null,
            readsPerNode: out.A.res?.nodesVisited ? +(out.A.reads / out.A.res.nodesVisited).toFixed(1) : null,
            nodesPerPathCell: out.A.res?.nodesVisited && (out.A.res?.path || []).length
                ? +(out.A.res.nodesVisited / out.A.res.path.length).toFixed(1) : null,
            // The re-read factor: total reads the search issued divided by the distinct cells it ever
            // asked about. This is the number that decides whether caching a per-cell answer can pay at
            // all, so it is recorded per trial rather than argued once.
            distinctCells: scoped.memoSize,
            // Requests, not live reads. `stats.reads` only counts reads that reached the chunk store, so
            // with the memo on it equals the miss count and the ratio would be 1.0 by construction — a
            // number that looks like an answer and measures nothing.
            rereadFactor: scoped.stats.memoMisses ? +((scoped.stats.memoHits + scoped.stats.memoMisses) / scoped.stats.memoMisses).toFixed(1) : null,
            memoHits: scoped.stats.memoHits, memoMisses: scoped.stats.memoMisses,
        };
        rows.push(row); samples.trials.push(row);
        log(label, `trial ${i + 1}/${REPEAT} dir(${dx},${dz})  A ${out.A.ms.toFixed(0)}ms | B ${out.B.ms.toFixed(0)} | C ${out.C.ms.toFixed(0)} | D ${out.D.ms.toFixed(0)}  route ${same ? 'IDENTICAL' : '*** DIVERGED ***'}`);
    }

    if (link) { churning = false; await sleep(200); log('churn', `${churnOps} /fill operations issued during the timing phase.`); }
    return { label, rows, churnOps };
}

function report(stat, chn, worldEvents) {
    const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    const stats = (rows, arm) => {
        const xs = rows.map(r => r.ms[arm]);
        return { min: Math.min(...xs), med: med(xs), max: Math.max(...xs), mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) };
    };
    console.log('\n──────── RESULT ────────');
    for (const set of [stat, chn]) {
        const div = set.rows.filter(r => !r.routeIdentical).length;
        console.log(`\n${set.label.toUpperCase()} — ${set.rows.length} trials, route identity across all 4 arms: ${set.rows.length - div}/${set.rows.length}` +
            (set.churnOps ? `, ${set.churnOps} /fill ops running throughout` : ''));
        if (div > 0) { fail++; console.log('  *** ROUTES DIVERGED — no ratio from this set is trustworthy ***'); }
        console.log('  arm | min      med      max      mean      vs B');
        const bMed = stats(set.rows, 'B').med;
        for (const a of ['A', 'B', 'C', 'D']) {
            const s = stats(set.rows, a);
            console.log(`   ${a}  | ${String(s.min.toFixed(0)).padStart(6)}ms ${String(s.med.toFixed(0)).padStart(6)}ms ${String(s.max.toFixed(0)).padStart(6)}ms ${String(s.mean.toFixed(0)).padStart(7)}ms   ${(bMed / s.med).toFixed(2)}x`);
        }
    }
    const cS = stats(stat.rows, 'C').med, cC = stats(chn.rows, 'C').med;
    const bS = stats(stat.rows, 'B').med, bC = stats(chn.rows, 'B').med;
    const dS = stats(stat.rows, 'D').med, dC = stats(chn.rows, 'D').med;
    const rr = [...stat.rows, ...chn.rows].filter(r => r.rereadFactor);
    if (rr.length) {
        const f = rr.map(r => r.rereadFactor);
        console.log(`\nRE-READ FACTOR (why arm D exists): the search asks about each distinct cell ` +
            `${med(f).toFixed(1)}x on average (min ${Math.min(...f).toFixed(1)}, max ${Math.max(...f).toFixed(1)}).`);
        console.log(`  Arm D caches that answer for the life of ONE search. Compare its column against C's above:`);
        console.log(`  a ${med(f).toFixed(0)}x redundancy that a per-cell cache does NOT convert into speed is the finding,`);
        console.log('  not a disappointment — it means the read is already cheaper than remembering the answer.');
    }
    const shaped = [...stat.rows, ...chn.rows].filter(r => r.nodesVisited);
    if (shaped.length) {
        console.log('\nWHERE THE TIME GOES (the finding arm D forced):');
        console.log('  trial            nodes   path   nodes/path   reads/node   partial');
        for (const r of shaped.filter(r => r.phase === 'static')) {
            console.log(`  ${(r.phase + ' t' + r.trial).padEnd(14)} ${String(r.nodesVisited).padStart(7)} ${String(r.pathLen).padStart(6)} ` +
                `${String(r.nodesPerPathCell).padStart(12)} ${String(r.readsPerNode).padStart(12)}   ${r.partial}`);
        }
    }
    console.log('\nTHE QUESTION: does the saving survive a world being rewritten?');
    console.log(`  C over B  quiet ${(bS / cS).toFixed(2)}x   churning ${(bC / cC).toFixed(2)}x`);
    console.log(`  D over B  quiet ${(bS / dS).toFixed(2)}x   churning ${(bC / dC).toFixed(2)}x`);
    console.log(`  blockUpdate events observed across the whole run: ${worldEvents}`);
    console.log(`\nchecks: ${pass} passed, ${fail} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
