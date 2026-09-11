'use strict';
// tool: stone_column_probe — drive stone_column_scanner against a LIVE world and audit its verdict
//       independently, before the verb that acts on it is ever raised in autonomy.
//
// WHY A PROBE AND NOT A BENCH SCENARIO — and the answer changed on 2026-09-10, so read the whole of it.
//
// THIS USED TO SAY the ranking was already proven elsewhere: `virtual_playground/scenario_stone_column`
// held it — a gate that refuses a broken run, a preference that picks the shallower of two whole ones —
// against voxels this repo authored, so the probe only had to cover what an authored world cannot reach.
// **That scenario no longer exists.** The bench was deleted whole on the ruling that a kept scenario
// freezes what was true when it was written (`Auren_Workshop/README.md`), and nothing inherited it.
// So the honest statement of this file's scope is: NOTHING ELSE TOUCHES THIS SCANNER. If the ranking
// regresses, this probe is where it surfaces, and it only runs when someone runs it.
//
// WHAT WAS NEVER IN DOUBT, and is the reason this is live rather than headless: whether the reader sees
// REAL terrain at all — chunk load state, biome variety, water and cave geometry, and the
// surface-vs-canopy question over actual trees. Those are things MINECRAFT decides, so they can only be
// READ (the rule that outlived the bench — `Auren_Workshop/README.md`, READ DON'T SIMULATE).
//
// THE ONE DISCIPLINE THAT MAKES THE RESULT MEAN ANYTHING (Law 26 — the unit does not grade its own
// paper): the audit below re-derives every field of the returned column from `bot.blockAt` DIRECTLY,
// never through the scanner's own voxel reader. If the audit shared the reader, a reader defect would
// be invisible — both sides would agree, and agreement would be the bug. Any disagreement here is a
// real finding regardless of which side is wrong.
//
// SAMPLES, NOT ONE SHOT: a single scan says nothing about a scanner meant to work anywhere. The probe
// teleports the body to a spread of positions and audits every verdict, so the summary answers "how
// often does it find one, and is every one it found sound" rather than "did it work once".
//
// EVERY column in the returned list is audited, not just the leader. The executor claims down the list
// until one is free and reachable, so a defect in the fifth candidate reaches a live shaft exactly as
// readily as one in the first — auditing only the winner would leave the whole fallback path untested.
// The ranking itself is checked here too: nearest first, shallowest only breaking the tie.
//
// The operator's pathway is RCON (tp only — no terrain is authored here, because the whole question is
// what natural ground looks like to this reader).
//
// Run (server must be UP — `fleet_control.js server-start` is the entire prerequisite):
//   . .\Auren_Workshop\scripts\_node.ps1 ; & (Get-AurenNode) Auren_Workshop\tools\stone_column_probe.js
//   env knobs: PROBE_SAMPLES (default 8) · PROBE_SPREAD blocks between samples (default 220)
//              PROBE_AT="x,z;x,z" samples those exact columns instead of the ring (aim at terrain
//                        the ring never lands on — ocean, desert, a mountain face)
//              PROBE_NAME (default testbot) · PROBE_HOST/PORT/VERSION

const path = require('path');
const paths = require('../workshop_paths');
paths.registerAliases();

// Isolated identity — a throwaway body writing into its OWN record, never a fleet bot's (Law 6).
process.env.BOT_ID = process.env.PROBE_NAME || 'testbot';

// The scanner narrates itself through watcher.summary; send that to the console and suppress the disk
// writers a probe must not touch.
const watcher = require('@kernel/watcher');
watcher.summary = (tag, msg) => console.log(`   [${tag}] ${msg}`);
watcher.warn = (tag, msg) => console.log(`   [warn] ${tag}: ${msg}`);
watcher.error = (tag, msg) => console.log(`   [ERROR] ${tag}: ${msg}`);

const mineflayer = require('mineflayer');
const Vec3 = require('vec3').Vec3;
const rconLink = require(paths.bot('js_kernel/utils/rcon_link'));
const stoneColumnScanner = require('@perception/stone_column_scanner');
const { isNotSafeSurface } = require('@utils/movement/terrain_predicates');
const { isGravityBlock, followGravityColumn } = require('@utils/gravity_utils');
const { STONE_PROSPECT } = require('@thinking/architect_config');

const HOST = process.env.PROBE_HOST || 'localhost';
const PORT = Number(process.env.PROBE_PORT || 25565);
const VERSION = process.env.PROBE_VERSION || '1.21.5';
const NAME = process.env.PROBE_NAME || 'testbot';
const SAMPLES = Number(process.env.PROBE_SAMPLES || 8);
const SPREAD = Number(process.env.PROBE_SPREAD || 220);
const AT = (process.env.PROBE_AT || '').split(';').filter(Boolean)
    .map(pair => { const [x, z] = pair.split(',').map(Number); return { x, z }; });

const RUN = STONE_PROSPECT.stone_run;
const LEAF_RE = /_leaves$/;
const LOG_RE = /(_log|_wood|_stem|_hyphae)$/;
const LIQUID = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column']);
const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function log(...a) { console.log('[stone_column_probe]', ...a); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── the INDEPENDENT audit ────────────────────────────────────────────────────────────────────
// Re-reads the column through mineflayer's own blockAt and checks every claim the scanner made.
// Returns a list of failed claims — empty means the column is sound as reported.
function auditColumn(bot, col, origin) {
    const faults = [];
    const at = (y) => bot.blockAt(new Vec3(col.x, y, col.z));
    const claim = (ok, msg) => { if (!ok) faults.push(msg); };

    // 1. The surface it named is ground, and the cell above it is open enough to stand in.
    const surface = at(col.surfaceY);
    claim(!!surface && surface.boundingBox === 'block', `surfaceY=${col.surfaceY} is not a full block (${surface?.name})`);
    if (surface) {
        claim(!LEAF_RE.test(surface.name) && !LOG_RE.test(surface.name),
            `surface is canopy, not ground (${surface.name}) — the walk-to target would be a branch`);
    }
    const above = at(col.surfaceY + 1);
    // An unloaded read is a FAULT here, not a pass. `!above` reading as permission is how a column over
    // an unread chunk audits clean — the failure mode this line exists to close.
    claim(!!above, `the stand cell at y=${col.surfaceY + 1} is unloaded — accepted on no evidence`);
    claim(!above || above.boundingBox !== 'block', `the stand cell above the column is capped (${above?.name})`);
    // A LIQUID stand cell passes every solidity test and still ruins the shaft: the body is swimming
    // rather than standing, and the first dig-down floods the column it is about to seal. Asked here
    // because it is exactly the case an authored flat world cannot present.
    claim(!above || !LIQUID.has(above.name),
        `the stand cell above the column is ${above?.name} — the shaft would flood`);

    // 2. Overburden as counted, and no deeper than the ceiling allows.
    let counted = 0, y = col.surfaceY;
    while (counted <= STONE_PROSPECT.max_overburden + 1) {
        const b = at(y);
        if (!b) { faults.push(`overburden walk hit an unloaded cell at y=${y}`); break; }
        if (b.name === 'stone') break;
        counted++; y--;
    }
    claim(counted === col.overburden, `overburden reported ${col.overburden}, world says ${counted}`);
    claim(col.overburden <= STONE_PROSPECT.max_overburden,
        `overburden ${col.overburden} exceeds the ceiling ${STONE_PROSPECT.max_overburden}`);

    // 3. THE GATE: the run is uninterrupted and it is all `stone`. Reported per-cell so a failure names
    //    which block broke it rather than only that one did.
    const topStoneY = col.surfaceY - col.overburden;
    for (let i = 0; i < RUN; i++) {
        const b = at(topStoneY - i);
        if (!b) { faults.push(`run cell ${i + 1}/${RUN} at y=${topStoneY - i} is unloaded`); continue; }
        if (b.name !== 'stone') faults.push(`run cell ${i + 1}/${RUN} at y=${topStoneY - i} is ${b.name}, not stone`);
    }

    // 4. The resting block — the floor the body stands on when the last of the run is gone.
    const restingY = topStoneY - RUN;
    claim(restingY === col.restingY, `restingY reported ${col.restingY}, derives to ${restingY}`);
    const resting = bot.blockAt(new Vec3(col.x, restingY, col.z));
    claim(!!resting && resting.boundingBox === 'block',
        `no resting block under the run at y=${restingY} (${resting?.name}) — the shaft ends in a drop`);
    if (resting) claim(!isNotSafeSurface(resting), `resting block is a hazard (${resting.name})`);

    // 5. Arithmetic the executor spends filler against.
    claim(col.standFeetY === restingY + 1, `standFeetY ${col.standFeetY} is not one above the resting block`);
    claim(col.depth === (col.surfaceY + 1) - (restingY + 1), `depth ${col.depth} does not match surface−resting`);
    claim(col.depth === col.overburden + RUN, `depth ${col.depth} ≠ overburden ${col.overburden} + run ${RUN}`);

    // 6. THE WALLS. Every cell the shaft opens must be enclosed on all four sides, or the dig makes a
    //    flow — into the shaft if the neighbour is a fluid, out of the shaft if it is a cave. Read
    //    straight off blockAt so a scanner that agreed with itself cannot pass this.
    for (let wy = col.surfaceY; wy > restingY; wy--) {
        for (const [dx, dz] of CARDINALS) {
            const nx = col.x + dx, nz = col.z + dz;
            const n = bot.blockAt(new Vec3(nx, wy, nz));
            if (!n) { faults.push(`wall ${nx},${wy},${nz} is unloaded — accepted on no evidence`); continue; }
            if (LIQUID.has(n.name)) { faults.push(`wall ${nx},${wy},${nz} is ${n.name} — the dig makes a flow`); continue; }
            if (n.boundingBox !== 'block') { faults.push(`wall ${nx},${wy},${nz} is ${n.name} (open) — the shaft breaches it`); continue; }
            if (isGravityBlock(n.name) && followGravityColumn(bot, nx, wy, nz) === 'CONDUIT') {
                faults.push(`wall ${nx},${wy},${nz} is a ${n.name} conduit — its column carries a fluid in`);
            }
        }
    }

    // 7. Standing room: the body is two cells tall, so one clear block is a suffocation, not a stand.
    const head = at(col.surfaceY + 2);
    claim(!!head, `the head cell at y=${col.surfaceY + 2} is unloaded`);
    if (head) {
        claim(head.boundingBox !== 'block', `no standing room — the head cell is ${head.name}`);
        claim(!LIQUID.has(head.name), `the head cell is ${head.name} — the body would be swimming`);
    }

    // 8. Never the cell the body is standing in (min_radius), or the descent begins under its own feet.
    const cheb = Math.max(Math.abs(col.x - origin.x), Math.abs(col.z - origin.z));
    claim(cheb >= STONE_PROSPECT.min_radius,
        `column is ${cheb} away, inside min_radius ${STONE_PROSPECT.min_radius}`);
    claim(cheb <= STONE_PROSPECT.max_radius, `column is ${cheb} away, past max_radius ${STONE_PROSPECT.max_radius}`);

    return { faults, cheb };
}

// ── one sample ───────────────────────────────────────────────────────────────────────────────
async function runOneSample(bot, rcon, n, target) {
    log(`──── sample ${n}/${AT.length || SAMPLES} @ x=${target.x} z=${target.z} ────`);
    // Teleport high and let the body fall to the ground it lands on — the surface is the world's to
    // choose, not the operator's. `spreadplayers` would pick for us; a drop reads what is there.
    await rcon.command(`tp ${NAME} ${target.x} 200 ${target.z}`);
    await sleep(1200);
    // Settle: wait for the body to stop falling AND for the chunk under it to answer.
    for (let i = 0; i < 30; i++) {
        const p = bot.entity.position.floored();
        const under = bot.blockAt(new Vec3(p.x, p.y - 1, p.z));
        if (under && under.boundingBox === 'block' && !bot.entity.velocity) break;
        if (under && under.boundingBox === 'block' && Math.abs(bot.entity.velocity.y) < 0.01) break;
        await sleep(400);
    }
    await sleep(1500);   // chunk radius around the landing, for the outer scan rings

    const origin = bot.entity.position.floored();
    const under = bot.blockAt(new Vec3(origin.x, origin.y - 1, origin.z));
    log(`landed at (${origin.x},${origin.y},${origin.z}) on ${under?.name || 'nothing'}`);

    const t0 = Date.now();
    const { columns, summary } = stoneColumnScanner.scan(bot);
    const ms = Date.now() - t0;
    const column = columns[0];

    if (!column) {
        const worst = Object.entries(summary.rejects).sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}:${v}`).join(' ');
        log(`  NO COLUMN — ${summary.examined} examined over ${summary.batches} batch(es) in ${ms}ms | ${worst}`);
        return { n, found: false, ms, examined: summary.examined, batches: summary.batches,
                 rejects: summary.rejects, faults: [] };
    }

    const { faults, cheb } = auditColumn(bot, column, origin);
    log(`  ${columns.length} column(s); best @${column.x},${column.z} (${cheb} away) surface y=${column.surfaceY} `
        + `overburden=${column.overburden} depth=${column.depth} — found in ${ms}ms, `
        + `${summary.examined} examined over ${summary.batches} batch(es)`);

    // The rest of the list, and the ranking that ordered it.
    let unsound = faults.length ? 1 : 0;
    for (let i = 1; i < columns.length; i++) {
        const r = auditColumn(bot, columns[i], origin);
        if (r.faults.length) {
            unsound++;
            log(`    ✗ candidate ${i + 1} @${columns[i].x},${columns[i].z}: ${r.faults.join('; ')}`);
        }
    }
    // NEAREST first, shallowest only breaking the tie — re-derived from the returned rows rather than
    // trusted from the order they arrived in.
    const rankFaults = [];
    for (let i = 1; i < columns.length; i++) {
        const a = columns[i - 1], b = columns[i];
        const da = (a.x - origin.x) ** 2 + (a.z - origin.z) ** 2;
        const db = (b.x - origin.x) ** 2 + (b.z - origin.z) ** 2;
        if (da > db) rankFaults.push(`#${i} @${a.x},${a.z} (d2=${da}) ranks above @${b.x},${b.z} (d2=${db})`);
        else if (da === db && a.overburden > b.overburden) {
            rankFaults.push(`#${i} @${a.x},${a.z} (ob=${a.overburden}) ties on distance but ranks above ob=${b.overburden}`);
        }
    }
    for (const f of rankFaults) log(`    ✗ RANK: ${f}`);

    const allFaults = [...faults, ...rankFaults];
    if (unsound === 0 && rankFaults.length === 0) {
        log(`  AUDIT: SOUND — all ${columns.length} candidate(s) re-derive from the world, ranking holds.`);
    } else {
        log(`  AUDIT: ${unsound} unsound candidate(s), ${rankFaults.length} ranking fault(s)`);
        for (const f of faults) log(`    ✗ best: ${f}`);
    }
    return { n, found: true, ms, examined: summary.examined, batches: summary.batches,
             rejects: summary.rejects, column, cheb, faults: allFaults, candidates: columns.length, unsound };
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: VERSION });
bot.on('error', (e) => log('BOT ERROR:', e.message));
bot.on('kicked', (r) => log('KICKED:', r));
bot.on('end', (r) => { log('disconnected:', r); process.exit(0); });

bot.once('spawn', async () => {
    log(`spawned as ${NAME} on ${HOST}:${PORT} (v${VERSION}); settling for chunks…`);
    await sleep(4000);

    const rcon = await rconLink.open(rconLink.readServerProperties());
    // The scan reads terrain only; a body that can be shot at or starve mid-sweep adds a variable the
    // question does not contain.
    await rcon.command(`gamemode creative ${NAME}`);

    const results = [];
    const spawn = bot.entity.position.floored();
    try {
        const count = AT.length || SAMPLES;
    for (let n = 1; n <= count; n++) {
            // A ring of samples around spawn: distinct terrain per sample without wandering so far
            // that the server spends the run generating chunks.
            const angle = (2 * Math.PI * (n - 1)) / SAMPLES;
            const target = AT.length ? AT[n - 1] : {
                x: spawn.x + Math.round(Math.cos(angle) * SPREAD),
                z: spawn.z + Math.round(Math.sin(angle) * SPREAD),
            };
            results.push(await runOneSample(bot, rcon, n, target));
        }
    } catch (e) {
        log('HARNESS ERROR:', e.stack || e.message);
    } finally {
        rcon.close();   // Law 8 — whoever opened it closes it
    }

    log('════════════════════ SUMMARY ════════════════════');
    for (const r of results) {
        if (!r.found) {
            const worst = Object.entries(r.rejects).sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}:${v}`).join(' ');
            log(`  ${String(r.n).padStart(2)}: NO COLUMN   ${String(r.ms).padStart(5)}ms  | ${worst}`);
            continue;
        }
        const verdict = (r.unsound || r.faults.length) ? `${r.unsound} UNSOUND` : 'SOUND';
        log(`  ${String(r.n).padStart(2)}: ${verdict.padEnd(11)} ${String(r.ms).padStart(5)}ms  `
            + `${String(r.candidates).padStart(3)} cand  `
            + `best @${r.column.x},${r.column.z} d=${r.cheb} overburden=${r.column.overburden} depth=${r.column.depth}`);
    }
    const found = results.filter(r => r.found);
    const sound = found.filter(r => r.faults.length === 0 && !r.unsound);
    const candidates = found.reduce((m, r) => m + r.candidates, 0);
    const slowest = results.reduce((m, r) => Math.max(m, r.ms), 0);
    log(`  found a column in ${found.length}/${results.length} samples; `
        + `${sound.length}/${found.length} samples audited SOUND against the world `
        + `(${candidates} candidate columns examined in total).`);
    log(`  slowest scan ${slowest}ms.`);
    // TRUE AGAINST THE ASKER'S CRITERIA (Law 25): the question was "can it find candidates AND are they
    // good". A high find rate with one unsound column is a FAILING result, not a mostly-passing one.
    const verdict = (found.length === results.length && sound.length === found.length)
        ? 'PASS — every sample found a column and every column audits sound'
        : (sound.length === found.length
            ? `PARTIAL — every column found audits sound, but ${results.length - found.length} sample(s) found none`
            : `FAIL — ${found.length - sound.length} column(s) did not survive the independent audit`);
    log(`  VERDICT: ${verdict}`);
    log('══════════════════════════════════════════════════');
    await sleep(300);
    bot.quit('probe done');
    process.exit(0);
});
