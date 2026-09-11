'use strict';
// tool: astar_reader_v2_bench — the live A/B/C that decides whether voxel_reader_v2_prototype ships.
// Architect 2026-08-04: "ok build a prototype and AB with all your recommendations. use a live server to
// determine if we save more time… i would like to see a signifigant reduction in scan time."
//
// SUPERSEDES astar_ab_bench.js, which compared raw blockAt against cartographer_prototype at the ADAPTER
// level. That reader shipped; the open question moved to a different seam (computeAStar's own
// opts.voxelReader), and three arms are needed to attribute the result rather than two. Keeping both
// would be two instruments answering one question (Law 16) — the old one stays only as the evidence
// behind the 2.35x already on the record, and is imported by nothing.
//
// ── THREE ARMS, ONE UNMODIFIED computeAStar ─────────────────────────────────────────────────────────
//   A  baseline   raw bot.blockAt per read           — what the fleet ran before 2026-08-04
//   B  shipped    voxel_reader, needs:['type']       — what the fleet runs now (2.35x over A)
//   C  prototype  voxel_reader_v2 + flags classify   — column memo, zero per-read allocation, and
//                                                      classifyFloorAt answering from packed bits
// The SAME search runs three times per trial. Nothing about A* changes between arms except which reader
// its world reads resolve to — that is what makes a timing difference attributable to the reader.
//
// ── ROUTE IDENTITY IS THE GATE, ACROSS ALL THREE ARMS, AND IT IS NEVER LOOSENED ─────────────────────
// Every trial compares the full route — every cell and every edge type — A vs B vs C. One divergence
// voids the trial and NO timing is printed. A faster reader that plans a different path has not sped
// pathfinding up, it has broken it, and printing its speedup would be a true number certifying a false
// claim (Law 25). C is the arm most able to diverge: it answers classifyFloor from flags instead of from
// block fields, so this gate is the only thing standing between "derived identically" and "looks close".
//
// ── READ COUNTS WILL NOT MATCH BETWEEN B AND C, BY DESIGN ───────────────────────────────────────────
// classifyFloorInline walks i=1..3 for 'jumpable' and then, on failure, walks i=1..2 AGAIN for
// 'walkable'. The flags path counts consecutive passable cells once and breaks. Same verdict, strictly
// fewer reads. The bench therefore reports reads per arm instead of asserting equality — an unequal read
// count between B and C is the saving, not a warning sign. Between A and B it MUST be equal, and that
// one is still asserted.
//
// ── WHAT THIS CANNOT PROVE (Law 25) ─────────────────────────────────────────────────────────────────
// One body, one server, one terrain sample, at whatever chunk-load state the day supplies. It measures
// the SEARCH, not a dispatch cycle, and it licenses the flags classify for A*'s floor question ONLY.
//
// Usage (server must be running):
//   . .\Auren_Workshop\scripts\_node.ps1 ; & (Get-AurenNode) `
//     Auren_Workshop\tools\astar_reader_v2_bench.js --dist=180 --nodes=200000 --repeat=3
//   …--no-mutate   skip phase 1 (only when rcon is unavailable; the run is then WEAKER evidence)

const path = require('path');
const paths = require('../workshop_paths');
paths.registerAliases();

const mineflayer = require('mineflayer');
const Vec3 = require('vec3');
const pathfinding = require('@utils/pathfinding_utils');
const { makeVoxelReader } = require('@utils/voxel_reader');
const { makeVoxelReaderV2 } = require('./voxel_reader_v2_prototype');
const rcon = require(paths.bot('js_kernel/utils/rcon_link'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find(a => a.startsWith(`--${k}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = k => argv.includes(`--${k}`);

const DIST     = Number(arg('dist', 32));
const REPEAT   = Number(arg('repeat', 5));
const MAXNODES = Number(arg('nodes', 8000));
const VERSION  = arg('version', '1.21.5');
const HOST     = arg('host', 'localhost');
const PORT     = Number(arg('port', 25565));
const USERNAME = arg('username', 'ReaderV2_AB');

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A route's full identity: every cell AND the edge type used to enter it. Endpoints alone would pass two
// genuinely different routes; length alone would pass two different routes of equal length.
function routeSignature(result) {
    if (!result) return 'NULL';
    const p = result.path || [];
    return `${result.partial ? 'PARTIAL' : 'FULL'}:${p.length}:` +
        p.map(s => `${s.type || s.action || 'move'}@${s.x || s.pos?.x},${s.y || s.pos?.y},${s.z || s.pos?.z}`).join('|');
}

async function main() {
    log('boot', `connecting ${USERNAME} to ${HOST}:${PORT} (${VERSION})…`);
    const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION, auth: 'offline' });
    bot.on('error', e => { log('boot', `socket error: ${e.message}`); process.exit(1); });
    bot.on('kicked', r => { log('boot', `kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`); process.exit(1); });
    await new Promise(res => bot.once('spawn', res));
    // Settle on the COLUMN COUNT, not a timer. A fixed sleep is a guess about how fast the server streams
    // chunks, and guessing short is what put drift inside the first trial of the 2026-08-04 run. Wait
    // until the loaded-column count stops growing for three consecutive samples.
    log('boot', 'spawned — waiting for the loaded-chunk set to stop growing…');
    let prev = -1, stable = 0;
    for (let i = 0; i < 60 && stable < 3; i++) {
        await sleep(500);
        const n = bot.world.getColumns().length;
        stable = (n === prev) ? stable + 1 : 0;
        prev = n;
    }
    log('boot', `${prev} columns loaded and stable.`);

    const shipped = makeVoxelReader(bot, { needs: ['type'] });
    const proto   = makeVoxelReaderV2(bot, { version: VERSION });
    if (!shipped.fast || !proto.fast) { log('boot', 'a reader fell to its slow path — the comparison is void.'); process.exit(1); }

    let ok = flag('no-mutate') ? true : await mutationPhase(bot, proto);
    if (!ok) { console.log('\nPhase 2 not run: a reader that cannot track a live change has nothing worth timing.'); bot.quit(); process.exit(1); }

    console.log('');
    ok = agreementPhase(bot, shipped, proto);
    if (!ok) { console.log('\nPhase 3 not run: readers that disagree about a cell have nothing worth timing.'); proto.dispose(); bot.quit(); process.exit(1); }

    console.log('');
    ok = await abPhase(bot, shipped, proto);

    console.log(`\ncolumn memo: ${proto.stats.columnHits} hits / ${proto.stats.columnMisses} misses ` +
        `(${(100 * proto.stats.columnHits / Math.max(1, proto.stats.columnHits + proto.stats.columnMisses)).toFixed(1)}% of reads reused the held column)`);
    proto.dispose();
    bot.quit();
    process.exit(ok ? 0 : 1);
}

// ── PHASE 1: does a HELD COLUMN REFERENCE see a live world change? ──────────────────────────────────
// This is the whole architectural claim of the prototype, made executable. The reader caches the chunk
// column object between reads. If that handle could ever answer with pre-change data, the "a reference
// cannot go stale" argument is dead and no timing below is worth reading.
//
// The order is deliberate and is what makes it a real test: read the cell FIRST so the column is
// definitely memoized, THEN change it on the server, THEN read again through the SAME held handle with
// no invalidation call of any kind between the two reads.
async function mutationPhase(bot, proto) {
    log('mutate', 'PHASE 1 — does a HELD column reference see a live server-side block change?');
    const base = bot.entity.position.floored();
    let target = null;
    for (let dx = 2; dx <= 6 && !target; dx++) {
        for (let dy = -2; dy <= 1 && !target; dy++) {
            const c = new Vec3(base.x + dx, base.y + dy, base.z);
            const b = bot.blockAt(c);
            if (b && b.name !== 'air' && b.boundingBox === 'block') target = c;
        }
    }
    if (!target) { log('mutate', 'FAIL — no solid cell found near the bot to mutate.'); return false; }

    // Prime the memo: this read caches the column that owns `target`.
    const before = { base: bot.blockAt(target), proto: proto.blockAt(target.x, target.y, target.z) };
    const misses0 = proto.stats.columnMisses;
    proto.blockAt(target.x, target.y, target.z);
    const memoized = proto.stats.columnMisses === misses0;
    log('mutate', `target (${target.x},${target.y},${target.z}) — baseline=${before.base?.name} proto=${before.proto?.name}  column memoized=${memoized}`);
    if (before.base?.name !== before.proto?.name) { log('mutate', 'FAIL — readers disagree BEFORE any change.'); return false; }
    if (!memoized) { log('mutate', 'FAIL — the column was not held between two reads of the same cell; the test would prove nothing.'); return false; }

    const original = before.base.name;
    let link;
    try { link = await rcon.open(rcon.readServerProperties()); }
    catch (e) { log('mutate', `FAIL — rcon unavailable (${e.message}). Re-run with --no-mutate to skip, but the run is weaker evidence.`); return false; }

    try {
        await link.command(`setblock ${target.x} ${target.y} ${target.z} air replace`);
        // Poll the AUTHORITATIVE reader, not a timer: we proceed only once mineflayer's own world has the
        // change, so the prototype is asked the question at a moment the answer is genuinely known to differ.
        let arrived = false;
        for (let i = 0; i < 60 && !arrived; i++) { await sleep(50); arrived = bot.blockAt(target)?.name === 'air'; }
        if (!arrived) { log('mutate', 'FAIL — the server change never reached the client world; nothing was tested.'); return false; }

        // NOTHING is called between the change and this read. No cache clear, no rebuild, no rescan.
        const after = proto.blockAt(target.x, target.y, target.z);
        const cls = proto.classifyFloorAt(target.x, target.y, target.z);
        log('mutate', `after /setblock air — proto=${after?.name}, classifyFloorAt=${cls}  (no invalidation call was made)`);
        const okNow = after?.name === 'air';
        log('mutate', okNow
            ? `PASS — ${original} -> air seen through the HELD column handle. The reference is to mineflayer's live column; the server writes the update INTO it.`
            : `FAIL — the held column reported ${after?.name} after the block became air. The column memo is unsound; the prototype is dead.`);
        return okNow;
    } finally {
        await link.command(`setblock ${target.x} ${target.y} ${target.z} ${original} replace`);
        link.close();
        log('mutate', `restored (${target.x},${target.y},${target.z}) to ${original}.`);
    }
}

// ── PHASE 1b: WHERE do the readers disagree, if they do? ────────────────────────────────────────────
// Added 2026-08-04 because the A-vs-B read-count guard fired and said only THAT the arms diverged, on a
// provably stable chunk set — which is a guard that can stop a bad run but cannot help fix one. A guard
// that fires must be able to name a coordinate (Law 24: mechanism is the developer's to hold, but it has
// to be recoverable at all). This sweeps the region the searches actually cover and compares the readers
// on exactly the fields A* consults, so a disagreement lands as an address rather than a mystery.
function agreementPhase(bot, shipped, proto) {
    const feet = bot.entity.position.floored();
    const R = 40, YR = 12;
    // The comparison key is the fields A* reads and NOTHING else. Adding light or biome here would fail
    // the prototypes for a difference the search cannot see — that is the reader licensed for a job it
    // was never given (its header says so), not a defect.
    const key = b => b === null ? 'NULL' : `${b.name}|${b.boundingBox}|${!!b.diggable}|${pathfinding.isFullHeightFloor(b)}`;
    let cells = 0, bad = 0;
    const firstBad = [];
    for (let x = feet.x - R; x <= feet.x + R; x++) {
        for (let z = feet.z - R; z <= feet.z + R; z++) {
            for (let y = feet.y - YR; y <= feet.y + YR; y++) {
                cells++;
                const a = key(bot.blockAt(new Vec3(x, y, z)));
                const b = key(shipped.blockAt(x, y, z));
                const c = key(proto.blockAt(x, y, z));
                if (a !== b || b !== c) {
                    bad++;
                    if (firstBad.length < 8) firstBad.push(`(${x},${y},${z})  A=${a}  B=${b}  C=${c}`);
                }
            }
        }
    }
    log('agree', `PHASE 1b — ${cells} cells compared across all three readers on the fields A* reads.`);
    if (bad === 0) { log('agree', 'PASS — every cell identical in all three arms.'); return true; }
    log('agree', `FAIL — ${bad}/${cells} cells disagree:`);
    firstBad.forEach(s => log('agree', `    ${s}`));
    return false;
}

// ── PHASE 2: A/B/C through the real search ──────────────────────────────────────────────────────────
async function abPhase(bot, shipped, proto) {
    log('ab', `PHASE 2 — one unmodified computeAStar, three readers. dist=${DIST} nodes=${MAXNODES} repeat=${REPEAT}`);

    const feet = bot.entity.position.floored();
    const start = new Vec3(feet.x, feet.y - 1, feet.z);
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

    // The world-change sensor. Every block the server rewrites anywhere in the loaded set lands here —
    // the same stream that keeps bot.world current, used as the bench's own evidence that a trial's two
    // arms searched the same world or did not.
    let worldEvents = 0;
    bot.on('blockUpdate', () => { worldEvents++; });

    // ONE adapter for all three arms, and every arm goes through the SAME opts.voxelReader seam. The
    // arms must differ in exactly one thing or the comparison is not about the reader.
    //
    // THE FIRST VERSION OF THIS BENCH GOT IT WRONG and its own guard is what caught it: arm A was given
    // an adapter with no `world` and no `entity` (so _fastVoxelView would decline and leave raw blockAt
    // in place), which meant arm A also searched with a different `entity` and a different `world` than
    // arms B and C. It read 104 fewer voxels than arm B on a 604k-read search with a provably stable
    // chunk set. Do not reintroduce the asymmetry to "keep arm A honest" — arm A stays honest by being
    // a reader that forwards to bot.blockAt, which is exactly what the fleet did before 2026-08-04.
    const adapter = { blockAt: p => bot.blockAt(p), inventory: bot.inventory, world: bot.world, version: bot.version, entity: bot.entity };

    // Arm A as a READER: raw bot.blockAt behind the same seam. It allocates a Vec3 per read because that
    // is what every pre-2026-08-04 call site did (`bot.blockAt(new Vec3(x, y, z))`) — this is the old
    // path measured, not a stand-in for it. No classifyFloorAt, so the flags shortcut stays disarmed.
    const rawStats = { reads: 0, unloaded: 0 };
    const armA = {
        fast: true,
        stats: rawStats,
        blockAt(x, y, z) { rawStats.reads++; const b = bot.blockAt(new Vec3(x, y, z)); if (!b) rawStats.unloaded++; return b; },
        resetStats() { rawStats.reads = 0; rawStats.unloaded = 0; },
    };

    async function run(extraOpts, goal) {
        const cpu0 = process.cpuUsage();
        const t0 = process.hrtime.bigint();
        const result = await pathfinding.computeAStar(adapter, start, goal, {

            maxNodes: MAXNODES,
            combatGate: false,   // a measurement steers no body; a gate here would abandon it to the judge
            ...extraOpts,
        });
        const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
        const c = process.cpuUsage(cpu0);
        return { wallMs, cpuMs: (c.user + c.system) / 1000, result, sig: routeSignature(result) };
    }

    const ARMS = [
        { name: 'A', reader: armA },
        { name: 'B', reader: shipped },
        { name: 'C', reader: proto },
    ];

    // Warm every arm and discard: the first search of a process pays JIT for A*'s whole graph, and
    // charging that to whichever arm ran first would manufacture a speedup out of ordering alone.
    const warm = { type: 'position', pos: new Vec3(start.x + 8, start.y, start.z + 8) };
    for (const a of ARMS) await run({ voxelReader: a.reader }, warm);

    const rows = [];
    let mismatches = 0, readMismatch = 0, driftTrials = 0;
    for (let i = 0; i < REPEAT; i++) {
        const [dx, dz] = DIRS[i % DIRS.length];
        const goal = { type: 'position', pos: new Vec3(start.x + dx * DIST, start.y, start.z + dz * DIST) };
        const colsBefore = bot.world.getColumns().length;
        const eventsBefore = worldEvents;

        // Rotate which arm runs first each trial: chunk state and GC pressure drift over a run, and a
        // fixed order would let that drift land entirely on one arm.
        const order = [0, 1, 2].map(k => (k + i) % 3);
        const out = [null, null, null];
        const readsOut = [0, 0, 0];
        for (const k of order) {
            const a = ARMS[k];
            a.reader.resetStats();
            out[k] = await run({ voxelReader: a.reader }, goal);
            readsOut[k] = a.reader.stats.reads;
        }

        const same = out[0].sig === out[1].sig && out[1].sig === out[2].sig;
        if (!same) mismatches++;
        // A vs B must be equal work — they ask identical questions of the same world. When they differ,
        // there are exactly two candidate causes and they must not be confused: the READER answered
        // differently (a real defect, voids the run) or the WORLD changed between the two arms. Guessing
        // between them would be the criteria-usurpation Law 25 names, so the bench MEASURES which it was.
        //
        // THE FIRST VERSION OF THIS GUARD USED THE LOADED-COLUMN COUNT AND IT WAS TOO WEAK — recorded so
        // it is not retried. A vanilla server is never frozen: grass spreads, leaves decay, water settles,
        // every random tick can rewrite a block INSIDE an already-loaded column, which moves no column
        // count at all. The guard fired on a stable count, and the localization pass then proved zero
        // cells disagreed and that a re-run of arm A's OWN reader reproduced arm B's count — i.e. the
        // variance was per-execution, not per-reader. The right sensor is the one the server already
        // provides for exactly this: `blockUpdate`, the same event stream that keeps bot.world current.
        const colsAfter = bot.world.getColumns().length;
        const drifted = colsAfter !== colsBefore || worldEvents !== eventsBefore;
        if (readsOut[0] !== readsOut[1]) { if (drifted) driftTrials++; else readMismatch++; }
        rows.push({ out, readsOut, same });
        log('ab', `trial ${i + 1}/${REPEAT} dir(${dx},${dz})  ` +
            `A ${out[0].wallMs.toFixed(0)}ms/${readsOut[0]} reads | ` +
            `B ${out[1].wallMs.toFixed(0)}ms/${readsOut[1]} | ` +
            `C ${out[2].wallMs.toFixed(0)}ms/${readsOut[2]}  |  route ${same ? 'IDENTICAL' : '*** DIVERGED ***'}`);
    }

    // Re-runs one trial with a RECORDING reader, then compares all three readers on exactly the cells
    // that search touched. Only called when the guard fires, so a clean run pays nothing for it.
    async function localize(trialIdx) {
        const [dx, dz] = DIRS[trialIdx % DIRS.length];
        const goal = { type: 'position', pos: new Vec3(start.x + dx * DIST, start.y, start.z + dz * DIST) };
        const seen = new Set();
        const st = { reads: 0, unloaded: 0 };
        const rec = {
            fast: true, stats: st,
            blockAt(x, y, z) { st.reads++; seen.add(`${x},${y},${z}`); return bot.blockAt(new Vec3(x, y, z)); },
            resetStats() { st.reads = 0; st.unloaded = 0; },
        };
        await run({ voxelReader: rec }, goal);
        const key = b => b === null ? 'NULL' : `${b.name}|${b.boundingBox}|${!!b.diggable}|${pathfinding.isFullHeightFloor(b)}`;
        let bad = 0; const first = [];
        for (const k of seen) {
            const [x, y, z] = k.split(',').map(Number);
            const a = key(bot.blockAt(new Vec3(x, y, z)));
            const b = key(shipped.blockAt(x, y, z));
            const c = key(proto.blockAt(x, y, z));
            if (a !== b || b !== c) { bad++; if (first.length < 8) first.push(`(${x},${y},${z})  A=${a}  B=${b}  C=${c}`); }
        }
        console.log(`  recorded ${seen.size} distinct cells over ${st.reads} reads; ${bad} disagree.`);
        first.forEach(s => console.log(`    ${s}`));
        return bad;
    }

    console.log('\n──────── RESULT ────────');
    if (mismatches > 0) {
        console.log(`ROUTE DIVERGENCE in ${mismatches}/${REPEAT} trials — NO timing is reported.`);
        console.log('A reader that plans a different path has not made pathfinding faster; it has broken it.');
        rows.filter(r => !r.same).slice(0, 1).forEach(r => {
            console.log(`  A: ${r.out[0].sig.slice(0, 200)}`);
            console.log(`  B: ${r.out[1].sig.slice(0, 200)}`);
            console.log(`  C: ${r.out[2].sig.slice(0, 200)}`);
        });
        return false;
    }
    if (readMismatch > 0) {
        console.log(`READ-COUNT DIVERGENCE between arms A and B in ${readMismatch}/${REPEAT} trials with a STABLE`);
        console.log('column count. Localizing over the cells the search ACTUALLY read…');
        // The box sweep in phase 1b is a coarse pre-check and can miss a disagreement outside its bounds;
        // this records the search's real read set and diffs the readers on exactly those cells, so the
        // answer is either a coordinate or a proof that no cell disagrees anywhere the search looked.
        const bad = await localize(rows.findIndex(r => r.readsOut[0] !== r.readsOut[1]));
        if (bad === 0) {
            console.log('  No cell disagrees anywhere the search read. The readers are consistent; the extra reads');
            console.log('  come from the SEARCH taking a different number of steps, not from a different answer.');
            console.log('  NO timing is reported — the cause is unexplained and an unexplained gap is not a pass.');
        }
        return false;
    }
    if (driftTrials > 0) {
        console.log(`NOTE: ${driftTrials}/${REPEAT} trials saw the world change mid-trial (blockUpdate fired, or the`);
        console.log('loaded-column set moved). Their A-vs-B read counts differ because the arms searched slightly');
        console.log('different worlds, not because a reader disagreed — route identity still held in those trials.');
    }
    console.log(`world changes observed during the run: ${worldEvents} blockUpdate events.`);

    const col = k => rows.map(r => r.out[k]);
    const sum = (k, f) => col(k).reduce((s, r) => s + r[f], 0);
    const reads = k => rows.reduce((s, r) => s + r.readsOut[k], 0);
    const [aw, bw, cw] = [sum(0, 'wallMs'), sum(1, 'wallMs'), sum(2, 'wallMs')];
    const [ac, bc, cc] = [sum(0, 'cpuMs'), sum(1, 'cpuMs'), sum(2, 'cpuMs')];

    console.log(`routes IDENTICAL across all three arms in ${REPEAT}/${REPEAT} trials — the timings below compare equal work.`);
    console.log(`  voxel reads   A ${reads(0)}   B ${reads(1)}   C ${reads(2)}`
        + `   (A==B asserted; C lower is the redundant re-read classifyFloorInline makes, removed)`);
    console.log(`  wall clock    A ${aw.toFixed(0)} ms   B ${bw.toFixed(0)} ms   C ${cw.toFixed(0)} ms`);
    console.log(`  cpu time      A ${ac.toFixed(0)} ms   B ${bc.toFixed(0)} ms   C ${cc.toFixed(0)} ms`);
    console.log(`  per search    A ${(aw / REPEAT).toFixed(0)} ms   B ${(bw / REPEAT).toFixed(0)} ms   C ${(cw / REPEAT).toFixed(0)} ms`);
    console.log(`  speedup       B over A ${(aw / bw).toFixed(2)}x   |   C over B ${(bw / cw).toFixed(2)}x   |   C over A ${(aw / cw).toFixed(2)}x`);
    console.log(`  saved by C vs today's fleet: ${((bw - cw) / REPEAT / 1000).toFixed(2)} s per search`);
    return true;
}

main().catch(e => { console.error(e); process.exit(1); });
