// fragment: stone_column_scanner (perception)
// purpose: find ONE surface column the bot may dig straight down to reach an uninterrupted run of
//          stone, and report it — or report that this sweep found none. Pure perception: it makes no
//          decisions and routes no signals (Law 1's direct-call exception, Law 3).
//
// ── WHY A COLUMN IS THE UNIT, AND WHY THE RUN IS A GATE RATHER THAN A PREFERENCE ──────────────────
// The verb this feeds digs a 1-wide shaft straight down and seals it on the way back up, so the only
// thing it can ever collect is what stands in ONE column. That makes the column the whole question:
// how much stone is under this XZ, is it continuous, and is there something solid to stand on when the
// last block of it is gone.
//
// Those three are not equal. Depth to stone is a PREFERENCE — a deeper column costs more digging and
// more sealing material but yields the same stone. An uninterrupted run is a GATE — a gap in it is
// either a cave (the shaft opens into a void the bot falls through, and the drops fall with it) or a
// pocket of something else (the run does not add up to the yield the caller asked for, so the verb
// would report a short haul against a criterion it silently lowered, Law 25). The two are ranked here
// rather than blended into a score, because a score lets a very shallow column with a broken run beat
// a slightly deeper whole one, which is the one trade that must never be made.
//
// ── THE RESTING BLOCK (Law 17) ────────────────────────────────────────────────────────────────────
// The column is checked one block PAST the run: the cell below the last stone must be a safe solid.
// That cell is where the bot stands when the dig finishes, so without it the final dig-down drops the
// body into whatever is under the run. The descent authority (navigator.digDownStep) already refuses
// that step for itself, block by block — this is the same rule asked ONCE, in advance, so a column
// that would strand the bot nine blocks down is never begun rather than abandoned mid-way.
//
// ── STONE MEANS `stone` ───────────────────────────────────────────────────────────────────────────
// Not the `stone` GROUP (which also carries andesite/diorite/granite). Those mine to themselves, not
// to cobblestone, so a run counted across them yields a pile no recipe in this fleet asks for. The
// run must be one material and that material is `stone`.
//
// ── A DIG MAY NOT MAKE A FLOW: THE SHAFT IS WALLED ON ALL FOUR SIDES ──────────────────────────────
// Every cell the shaft opens must have a full solid block on each of its four cardinal neighbours, for
// the whole depth. This guard carries the most, because the failure it prevents is not the bot's own
// loss — a shaft that breaches water becomes a permanent flow into whatever it drains into, and the
// fleet cannot undo it. The same wall rule also excludes the cave the run test cannot see: a column can
// be nine whole blocks of stone and still sit against an open cavern the body falls sideways into.
//
// Solidity alone is not enough for a wall, and the exception is not a special case invented here — it
// is the mine's own gravel doctrine (gravity_utils.followGravityColumn): sand and gravel are FULL
// blocks and still fail as walls, because the column they belong to collapses into the shaft and
// whatever caps or borders that column follows it in. A wall is therefore solid, not fluid, and — if it
// is a gravity block — not a conduit.
//
// ── WHAT COUNTS AS THE SURFACE IS NOT THIS FILE'S TO DECIDE ───────────────────────────────────────
// The shaft starts at the surface, and "the surface" already has one definition in this tree —
// site_geometry.surfaceY, the test find_buildingspot sites every base against. Answering it here
// instead would let the shaft and the base disagree about where the ground is (Law 16). The canopy
// suffix rule is applied by the CALLER, as site_geometry's own header requires: a column whose topmost
// ground is a trunk is refused rather than read past, because the pillar back out would come up
// through the tree.
//
// ── RANKED NEAREST-FIRST, THEN SHALLOWEST ─────────────────────────────────────────────────────────
// Distance is the primary key and depth only breaks its ties, because the two costs are not the same
// kind. A deeper column costs a few more digs and a little more filler — bounded, and paid once. A
// farther column costs a route, and a route is where this fleet actually fails: it can be blocked,
// re-planned, or refused outright by terrain the scan never looked at. So the cheap certain cost is
// preferred over the small uncertain one. A Chebyshev ring holds 8r cells at the same distance, so the
// depth key is doing real work rather than sitting unused behind a rarely-equal first key.
//
// A LIST, not a winner. The caller claims a column before walking to it, so it must be able to take
// the next one when a peer already holds this one or the body cannot reach it — a single best answer
// would make every contested column a conceded trip.
//
// ── UNSENSED IS NOT PERMISSION (Law 13) ───────────────────────────────────────────────────────────
// Every read here rejects on null rather than reading past it. An unloaded chunk is the one state that
// looks identical to open air through a solidity test, so a column accepted across one has been
// accepted on no evidence at all.

'use strict';

const watcher = require('@kernel/watcher');
const blueprintSurvey = require('@perception/blueprint_survey');
const { makeVoxelReader } = require('@utils/voxel_reader');
const { isNotSafeSurface, getClearance, belowDepthFloor } = require('@utils/movement/terrain_predicates');
const { isFluid, isGravityBlock, followGravityColumn } = require('@utils/gravity_utils');
const { surfaceY: groundYAt, isCanopy } = require('@utils/site_geometry');
const { STONE_PROSPECT } = require('@thinking/architect_config');

const TAG = 'stone_column_scanner';

// The material the run must be made of, and the only one. See the header.
const RUN_BLOCK = 'stone';

// The four faces a 1-wide shaft exposes. The vertical neighbours are the shaft itself and the way out,
// so only the horizontals can leak into it.
const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Standing room: the body occupies two cells, so one clear block over the surface is not a place it can
// stand — it is a place it suffocates. Asked through the fleet's own clearance predicate rather than
// re-counted here, so the shaft and the route agree about which cells a body fits in (Law 16).
const STAND_CLEARANCE = 2;

// One reader per bot (the number→description table memoizes inside it), dropped with the bot.
// Mirrors surface_filter — Law 16, one reader-lifecycle rule, not a second one invented here.
const _readers = new WeakMap();
function readerFor(bot) {
    let r = _readers.get(bot);
    if (!r) { r = makeVoxelReader(bot, { needs: ['type'] }); _readers.set(bot, r); }
    return r;
}

// Chebyshev rings outward from the origin — nearest-first without sorting, which is what lets the
// caller stop at the first batch that yields a fit and never look at the rest.
function* _ringCells(cx, cz, minR, maxR) {
    for (let r = minR; r <= maxR; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // perimeter only
                yield [cx + dx, cz + dz];
            }
        }
    }
}

// A wall the shaft may be opened against: readable, solid, not a fluid, and not a gravity column that
// would collapse and bring one in. Returns null when the wall holds, or the reason it does not.
// Kept out of _evaluate because it is the EXPENSIVE question — four reads per level against one per
// level for everything else — and is therefore asked last, only of columns that already passed.
function _wallFault(bot, reader, x, y, z) {
    for (const [dx, dz] of CARDINALS) {
        const nx = x + dx, nz = z + dz;
        const n = reader.blockAt(nx, y, nz);
        if (!n) return 'wall_unloaded';
        if (isFluid(n.name)) return 'wall_fluid';
        if (n.boundingBox !== 'block') return 'wall_open';
        if (isGravityBlock(n.name) && followGravityColumn(bot, nx, y, nz) === 'CONDUIT') return 'wall_conduit';
    }
    return null;
}

// Evaluate one column. Returns the fit, or a short reason it is not one (the reason is kept for the
// summary line — a scan that rejects 64 columns for 64 different causes reads very differently from
// one that rejects them all for the same cause, and that difference is the diagnosis).
function _evaluate(bot, reader, x, z, refY, protectedKeys) {
    // THE SPAWN-PROTECTED SQUARE, BEFORE THE FIRST WORLD READ. A prospecting column is nothing but a
    // plan to dig a shaft straight down, and the square is full-height — so a protected column is not a
    // worse candidate, it is not a candidate: every cell of the run is unbreakable, top to bottom.
    // Cheapest possible gate (two subtractions, no blockAt) placed ahead of the column walk, which
    // costs a read per level plus four per wall.
    // ONE XZ TEST COVERS THE WHOLE SHAFT — that is the shape of the rule, not a shortcut: spawn
    // protection has no vertical term, so if the surface cell is inside the square, so is every cell
    // beneath it, and if it is outside, so is all of it. Contrast the blueprint check further down,
    // which must walk the column because blueprint voxels are placed at particular heights.
    if (require('@perception/spawn_protection').isSpawnProtected(bot, x, z)) {
        return { fit: null, why: 'spawn_protected' };
    }
    const ground = groundYAt(reader, x, z, refY, STONE_PROSPECT.scan_up, STONE_PROSPECT.scan_down);
    if (!ground) return { fit: null, why: 'no_ground' };
    if (isCanopy(ground.name)) return { fit: null, why: 'canopy' };
    const surfaceY = ground.y;

    // The stand cell above the column, and the one above THAT: the body has to fit there before it can
    // dig anything, and it must not be standing in a fluid when it does. A flooded stand cell passes
    // every solidity test ever asked of it — water reports `empty` — and the first dig-down then opens
    // the shaft underneath the water the body is swimming in.
    const above = reader.blockAt(x, surfaceY + 1, z);
    if (!above) return { fit: null, why: 'unloaded' };
    if (above.boundingBox === 'block') return { fit: null, why: 'capped' };
    if (isFluid(above.name)) return { fit: null, why: 'flooded' };
    const surfaceBlock = reader.blockAt(x, surfaceY, z);
    if (!surfaceBlock) return { fit: null, why: 'unloaded' };
    if (!getClearance(bot, surfaceBlock, STAND_CLEARANCE)) return { fit: null, why: 'no_headroom' };

    let overburden = 0;
    let y = surfaceY;
    // Walk down to the first `stone`. Anything non-solid on the way is a cave mouth or an overhang,
    // and anything unsafe is a hazard the shaft would breach — both disqualify the column outright
    // rather than being counted as overburden.
    while (overburden <= STONE_PROSPECT.max_overburden) {
        const b = reader.blockAt(x, y, z);
        if (!b) return { fit: null, why: 'unloaded' };
        if (b.name === RUN_BLOCK) break;
        if (b.boundingBox !== 'block') return { fit: null, why: 'void_above_stone' };
        if (isNotSafeSurface(b)) return { fit: null, why: 'hazard' };
        // A gravity block IN the shaft is not refused for falling — the descent re-mines what drops.
        // It is refused when its column is what a fluid rides down (the mine's gravel doctrine).
        if (isGravityBlock(b.name) && followGravityColumn(bot, x, y, z) === 'CONDUIT') {
            return { fit: null, why: 'gravity_conduit' };
        }
        overburden++;
        y--;
    }
    if (overburden > STONE_PROSPECT.max_overburden) return { fit: null, why: 'stone_too_deep' };

    // THE GATE. Every one of the next `stone_run` cells must be `stone` — no gap, no other material.
    const topStoneY = y;
    for (let i = 0; i < STONE_PROSPECT.stone_run; i++) {
        const b = reader.blockAt(x, topStoneY - i, z);
        if (!b) return { fit: null, why: 'unloaded' };
        if (b.name !== RUN_BLOCK) return { fit: null, why: 'run_broken' };
    }

    // The resting block: one past the run, solid and safe. See the header.
    const restingY = topStoneY - STONE_PROSPECT.stone_run;
    if (belowDepthFloor(restingY)) return { fit: null, why: 'below_depth_floor' };
    const resting = reader.blockAt(x, restingY, z);
    if (!resting || resting.boundingBox !== 'block') return { fit: null, why: 'no_floor' };
    if (isNotSafeSurface(resting)) return { fit: null, why: 'floor_hazard' };

    // Nothing in the shaft, nor the cell the bot stands in to start it, may belong to a blueprint.
    // Checked over the whole column rather than the footprint alone, because the shaft passes through
    // every cell between the stand and the resting block.
    if (protectedKeys) {
        for (let py = surfaceY + 1; py >= restingY; py--) {
            if (protectedKeys.has(`${x},${py},${z}`)) return { fit: null, why: 'blueprint' };
        }
    }

    // THE WALLS, LAST. Every cell the shaft opens — the surface block down to the last of the run —
    // must be enclosed on all four sides. Asked here rather than during the walk down because it costs
    // four reads per level: a column that fails a cheaper gate must never pay for this one.
    for (let wy = surfaceY; wy > restingY; wy--) {
        const fault = _wallFault(bot, reader, x, wy, z);
        if (fault) return { fit: null, why: fault };
    }

    return {
        fit: {
            x, z,
            surfaceY,                      // topmost ground block; the bot starts standing on it
            overburden,                    // non-stone blocks above the run
            standFeetY: restingY + 1,      // where the bot ends up when the run is gone
            restingY,                      // the block it stands on there
            depth: (surfaceY + 1) - (restingY + 1),   // blocks to dig, and blocks to seal on the way out
            dist2: 0,                      // filled by the caller, which is what knows the origin
        },
        why: null,
    };
}

// scan(bot) → { columns, summary }
// `columns` is EMPTY when no batch produced a fit. That is a legitimate world state, not a failure —
// the caller decides what to do about it (Law 3: this node has no opinion).
function scan(bot) {
    if (!bot?.entity?.position) {
        throw new Error(`[${TAG}] CODING VIOLATION: scan called with no bot loaded.`);
    }
    const reader = readerFor(bot);
    const feet = bot.entity.position.floored();

    // Sensed, not declared: only cells the world ALREADY matches are protected, so virgin rock inside a
    // future wall's footprint does not veto a column. See blueprint_survey.worldVoxelKeys.
    const protectedKeys = blueprintSurvey.getAllProtectedBlocks(bot);

    const cells = _ringCells(feet.x, feet.z, STONE_PROSPECT.min_radius, STONE_PROSPECT.max_radius);
    const rejects = {};
    let examined = 0;
    let batches = 0;

    while (batches < STONE_PROSPECT.max_batches) {
        let inBatch = 0;
        const fits = [];
        while (inBatch < STONE_PROSPECT.scan_batch) {
            const next = cells.next();
            if (next.done) break;
            const [x, z] = next.value;
            inBatch++; examined++;
            const { fit, why } = _evaluate(bot, reader, x, z, feet.y, protectedKeys);
            if (!fit) { rejects[why] = (rejects[why] || 0) + 1; continue; }
            fit.dist2 = (x - feet.x) ** 2 + (z - feet.z) ** 2;
            fits.push(fit);
        }
        batches++;
        if (fits.length) {
            // Nearest first, shallowest breaking the tie. Squared horizontal distance — the vertical
            // leg is the shaft the bot came to dig, so counting it would rank a column by its own
            // depth twice.
            fits.sort((a, b) => (a.dist2 - b.dist2) || (a.overburden - b.overburden));
            const best = fits[0];
            watcher.summary(TAG, `${fits.length} column(s), best @${best.x},${best.z} surface y=${best.surfaceY} `
                + `overburden=${best.overburden} run=${STONE_PROSPECT.stone_run} depth=${best.depth} `
                + `| batch ${batches}, ${examined} columns examined`);
            return { columns: fits, summary: { batches, examined, rejects } };
        }
        if (inBatch < STONE_PROSPECT.scan_batch) break;   // ran out of world before running out of batches
    }

    const worst = Object.entries(rejects).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' ');
    watcher.summary(TAG, `no column: ${examined} examined over ${batches} batch(es) | ${worst || 'nothing scanned'}`);
    return { columns: [], summary: { batches, examined, rejects } };
}

module.exports = { scan };
