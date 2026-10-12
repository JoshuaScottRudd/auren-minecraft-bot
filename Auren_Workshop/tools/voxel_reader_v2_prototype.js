'use strict';

// A process root resolves its own modules and registers its own alias map, so this file runs standalone
// without depending on a parent having set NODE_PATH (Law 16).
require('../workshop_paths').registerAliases();
// tool: voxel_reader_v2_prototype — a reader that holds a live reference to the world map across reads
// and answers state ids from it directly. Touches nothing the fleet runs: no fragment imports it; the
// only consumers are the two A/B benches that measure it against the shipped `voxel_reader`.
//
// ── WHAT THIS PROTOTYPE IS ──────────────────────────────────────────────────────────────────────────
// It reads state ids through mineflayer's own live column (`bot.world`, kept current by the server's
// block_change / multi_block_change packets), holding the column reference across reads so each read is
// a lookup into an already-resolved column — no column key, hash lookup, or Vec3 allocation per read.
//
//     cache a REFERENCE to the live column   — free, and cannot go stale: that object IS mineflayer's
//                                              column, and the server's updates land inside it.
//     cache a DERIVED VERDICT about a cell   — costs an invalidation surface and a bound. NOT DONE HERE.
//
// Nothing position-keyed is ever stored, so the mutation phase of the A/B bench (rcon /setblock with no
// invalidation call between reads) passes for the same reason it passes for the shipped reader: there is
// nothing stale to invalidate.
//
// ── THE THREE CHANGES UNDER TEST ────────────────────────────────────────────────────────────────────
// (1) COLUMN MEMO. Holds the last column read; consecutive reads landing in the same 16x16 column become
//     two integer compares in place of a string key and Map hash. Invalidated on chunkColumnUnload/Load,
//     the one way the handle can go bad (see the note at the invalidation listener — a search yields to
//     the cooperative pacer, so an unload can land mid-search).
// (2) NO PER-READ ALLOCATION. The column lookup takes integers directly and the in-chunk offset reuses
//     one scratch vector. Verified safe: ChunkColumn's `getBlockStateId` reads pos.x/y/z, converts to a
//     section index, and retains nothing.
// (3) A FLAGS PATH FOR THE HOTTEST QUESTION. `classifyFloorAt` answers walkable/jumpable/null from
//     packed per-state-id bits with no block object built at all. A* asks this once per direction per
//     node through `classifyFloorInline`, the majority of every search's reads.
//
// ── (3) IS ALSO A READ-COUNT SAVING ─────────────────────────────────────────────────────────────────
// `classifyFloorInline` walks i=1..3 for 'jumpable' and, on failure, walks i=1..2 again for 'walkable',
// re-reading cells it just read. The flags path counts consecutive passable cells once and breaks: same
// verdict, fewer reads. The bench reports read counts for both arms (Law 25); route identity is what
// gates the timing.
//
// ── THE BORROWED SHELL (opt-in, and dangerous by default — read before using) ───────────────────────
// `borrowBlockAt` returns a per-state-id MEMOIZED shell whose `position` is mutated in place, so a read
// costs three field writes instead of an object plus a Vec3. Its contract: **valid only until the next
// read**. That is legal for the siting sweep (site_geometry reads `.name`/`.boundingBox` immediately and
// retains only strings) and ILLEGAL for A* (`classifyFloorInline` holds `floorBlock.position` across
// three further reads, which would clobber it mid-loop). A caller that retains a borrowed shell gets a
// well-formed falsehood (Law 26), so this path is opt-in and labelled.
//
// PRECISELY WHEN IT BITES: shells are memoized PER STATE ID, so a retained shell is clobbered by the
// next read **of the same state id**, not by the next read of anything. The corruption is intermittent
// and data-dependent: a misusing caller passes every test where the two cells happen to hold different
// blocks and fails the instant they match, which in a stone wall or a grass field is nearly always.

// No module-alias registration here: this is a library, not an entry point. Its consumers (the benches)
// register the aliases against Auren_Bot/ before requiring it; a second registration would append the
// base path to itself, so '@utils/...' would resolve to Auren_Bot/Auren_Bot/... and the load would die.
const Vec3 = require('vec3');
const pf = require('@utils/pathfinding_utils');
const { isWalkableSurface } = require('@utils/movement/terrain_predicates');
const { isWaterSource } = require('@utils/gravity_utils');
const { STATION_TYPES } = require('@utils/fragment_utils');

// Same flag set and same derivation rule as the shipped reader: verdicts come from calling the real
// predicates against a prototype block, not from copied name lists — a copied membership set drifts and
// routes a body through a wall instead of throwing.
const F = {
    WALKABLE: 1 << 0, PASSABLE: 1 << 1, SOLID: 1 << 2, FULL_HEIGHT: 1 << 3,
    LEAF: 1 << 4, DOOR: 1 << 5, SCAFFOLD: 1 << 6, STATION: 1 << 7, KNOWN: 1 << 8,
    WATER_SOURCE: 1 << 9,
};
const UNLOADED = -1;

let _tables = null;
function tableFor(version) {
    if (!_tables) _tables = new Map();
    let t = _tables.get(version);
    if (t) return t;
    const Block = require('prismarine-block')(version);
    const flags = [];
    const protos = [];
    const shells = [];
    t = {
        flags(stateId) {
            let f = flags[stateId];
            if (f !== undefined) return f;
            const b = this.proto(stateId);
            if (!b) { flags[stateId] = 0; return 0; }
            f = F.KNOWN;
            if (isWalkableSurface(b))            f |= F.WALKABLE;
            if (pf.isBlockPassable(b))           f |= F.PASSABLE;
            if (pf.isBlockSolid(b))              f |= F.SOLID;
            if (pf.isFullHeightFloor(b))         f |= F.FULL_HEIGHT;
            if (pf.isLeafFloor(b))               f |= F.LEAF;
            if (pf.isDoorBlock(b))               f |= F.DOOR;
            if (pf.isScaffoldBlock(b.name))      f |= F.SCAFFOLD;
            if (STATION_TYPES.has(b.name))       f |= F.STATION;
            if (isWaterSource({ blockAt: () => b }, 0, 0, 0)) f |= F.WATER_SOURCE;
            flags[stateId] = f;
            return f;
        },
        proto(stateId) {
            let p = protos[stateId];
            if (p !== undefined) return p;
            try { p = Block.fromStateId(stateId, 0); } catch (_) { p = null; }
            if (p) p.position = new Vec3(0, 0, 0);
            protos[stateId] = p;
            return p;
        },
        // One reusable shell per state id, for borrowBlockAt. Built with the same key order and literal
        // as the fresh-shell path so both share one hidden class; a mismatched shape here makes every
        // downstream `.name` read polymorphic and costs back the gain the shell exists to produce.
        shell(stateId) {
            let s = shells[stateId];
            if (s !== undefined) return s;
            const p = this.proto(stateId);
            if (!p) { shells[stateId] = null; return null; }
            s = {
                type: p.type, metadata: p.metadata, light: p.light, skyLight: p.skyLight, biome: p.biome,
                position: new Vec3(0, 0, 0),
                stateId: p.stateId, computedStates: p.computedStates, name: p.name, hardness: p.hardness,
                displayName: p.displayName, shapes: p.shapes, boundingBox: p.boundingBox,
                transparent: p.transparent, diggable: p.diggable, material: p.material,
                harvestTools: p.harvestTools, drops: p.drops, _properties: p._properties,
                isWaterlogged: p.isWaterlogged,
            };
            shells[stateId] = s;
            return s;
        },
        get size() { return protos.filter(Boolean).length; },
    };
    _tables.set(version, t);
    return t;
}

// makeVoxelReaderV2(bot, opts) -> reader
//   opts.version — mc version for the block registry. Default from the bot.
//
// Interface-compatible with the shipped makeVoxelReader for needs:['type'] (blockAt / flagsAt / stats /
// resetStats / statesSeen / fast), plus `classifyFloorAt`, `borrowBlockAt` and `dispose`.
// ── THE SEARCH-SCOPED MEMO (opts.searchScoped) ──────────────────────────────────────────────────────
// A* re-asks about the same cell many times within a single search. The memo answers each cell once per
// search and is scoped and cleared with it: built lazily (only cells the search touches), unbounded
// (grows with the search, so it imposes no horizon), free when nobody is pathfinding, and with no
// invalidation surface because it does not outlive the question.
//
// Within one search a cell is answered once and reused, so a block that changes mid-search is not seen
// by later reads of it. This keeps the search consistent with one world state, which is what a route is
// a statement about; the walker re-senses and re-plans regardless (Law 12: interrupted chains die, the
// judge dispatches fresh).
//
// The key is packed relative to the search origin: 11 bits dx, 11 bits dz, 9 bits y — a plain 31-bit int,
// so the Map stays integer-keyed. Cells outside that range read live; the memo only answers for cells
// inside it.
const MEMO_XZ_RANGE = 1023;   // +/- 1023 blocks from origin; a search past that reads live
function packKey(dx, dz, y) { return ((dx + 1024) << 20) | ((dz + 1024) << 9) | (y + 64); }

function makeVoxelReaderV2(bot, opts = {}) {
    const version = opts.version || bot?.version || require('@thinking/architect_config').SERVER_MINECRAFT_VERSION;
    const stats = { reads: 0, unloaded: 0, columnHits: 0, columnMisses: 0, memoHits: 0, memoMisses: 0 };
    const table = tableFor(version);

    // Same construction-time check the shipped reader makes: a bench adapter or the virtual playground's
    // bot answers blockAt and nothing else, so there is no chunk store to read numbers from. Checked up
    // front, so a worldless bot gets the slow fallback below, not a throw on its first read.
    const hasWorld = typeof bot?.world?.getColumn === 'function';
    if (!hasWorld) {
        const slow = {
            fast: false, worldless: true, stats, FLAGS: F, UNLOADED, _version: version,
            blockAt(x, y, z) { stats.reads++; const b = bot.blockAt(new Vec3(x, y, z)); if (!b) stats.unloaded++; return b; },
            borrowBlockAt(x, y, z) { return slow.blockAt(x, y, z); },
            flagsAt(x, y, z) { const b = slow.blockAt(x, y, z); return b ? table.flags(b.stateId) : UNLOADED; },
            classifyFloorAt(x, y, z) { return classify(slow, x, y, z); },
            get statesSeen() { return table.size; },
            resetStats() { stats.reads = 0; stats.unloaded = 0; stats.columnHits = 0; stats.columnMisses = 0; stats.memoHits = 0; stats.memoMisses = 0; },
            beginSearch() {},
            get memoSize() { return 0; },
            dispose() {},
        };
        return slow;
    }

    // ── (1) THE COLUMN MEMO ─────────────────────────────────────────────────────────────────────────
    // `col` holds mineflayer's own ChunkColumn object, the one the server's block updates are written
    // into — not a copy — so holding it cannot produce a stale read of a block: the blocks are not what
    // is being held.
    let cx = 0x7fffffff, cz = 0x7fffffff, col = null;

    // ── (2) THE SCRATCH VECTOR ──────────────────────────────────────────────────────────────────────
    // One scratch vector per reader, mutated in place and never retained: ChunkColumn.getBlockStateId
    // reads x/y/z into a section index and an integer offset and keeps no reference. Scoped per reader so
    // two readers on two bots in one process cannot interleave into each other's scratch.
    const scratch = new Vec3(0, 0, 0);

    // ── INVALIDATION: the ONE way a held column handle can go bad ───────────────────────────────────
    // Not staleness of block data — the object is live — but identity: on unload mineflayer drops the
    // column from the world, and a reader still holding it would answer from a region outside the bot's
    // current perception, reporting unsensed space as solid terrain, the verdict Law 23 forbids most.
    // computeAStar yields to the cooperative pacer mid-search, so an unload can land between two reads of
    // one search.
    const onColumnChange = () => { cx = 0x7fffffff; cz = 0x7fffffff; col = null; };
    const w = bot.world;
    w.on('chunkColumnUnload', onColumnChange);
    w.on('chunkColumnLoad', onColumnChange);

    // Search-scoped memo state. `memo` is null unless the caller opts in via `opts.searchScoped`; the
    // non-memo path costs only this one null check.
    const memo = opts.searchScoped ? new Map() : null;
    let ox = 0, oy = 0, oz = 0;   // the search origin the keys are packed relative to

    function liveStateIdAt(x, y, z) {
        stats.reads++;
        const qx = x >> 4, qz = z >> 4;      // arithmetic shift: correct for negatives, unlike /16|0
        if (qx !== cx || qz !== cz) {
            stats.columnMisses++;
            col = w.getColumn(qx, qz);
            cx = qx; cz = qz;
        } else {
            stats.columnHits++;
        }
        if (!col) { stats.unloaded++; return -1; }
        scratch.x = x & 15; scratch.y = y; scratch.z = z & 15;
        return col.getBlockStateId(scratch);
    }

    function stateIdAt(x, y, z) {
        if (memo === null) return liveStateIdAt(x, y, z);
        const dx = x - ox, dz = z - oz;
        // Range guard: outside it the key would alias another cell. A memo that declines is safe; a
        // memo that mis-keys is a falsehood.
        if (dx > MEMO_XZ_RANGE || dx < -MEMO_XZ_RANGE || dz > MEMO_XZ_RANGE || dz < -MEMO_XZ_RANGE || y < -64 || y > 447) {
            return liveStateIdAt(x, y, z);
        }
        const k = packKey(dx, dz, y);
        const hit = memo.get(k);
        if (hit !== undefined) { stats.memoHits++; return hit; }
        stats.memoMisses++;
        const v = liveStateIdAt(x, y, z);
        memo.set(k, v);
        return v;
    }

    const reader = {
        fast: true, worldless: false, unmetNeeds: [], _version: version,
        stats, FLAGS: F, UNLOADED,
        stateIdAt,
        flagsAt(x, y, z) { const s = stateIdAt(x, y, z); return s < 0 ? UNLOADED : table.flags(s); },

        // Fresh shell — safe to retain. Same literal, same key order, same hidden class as the shipped
        // reader's, so this arm differs from it in the LOOKUP only. That is what makes the A/B attributable.
        blockAt(x, y, z) {
            const s = stateIdAt(x, y, z);
            if (s < 0) return null;
            const p = table.proto(s);
            if (!p) return null;
            return {
                type: p.type, metadata: p.metadata, light: p.light, skyLight: p.skyLight, biome: p.biome,
                position: new Vec3(x, y, z),
                stateId: p.stateId, computedStates: p.computedStates, name: p.name, hardness: p.hardness,
                displayName: p.displayName, shapes: p.shapes, boundingBox: p.boundingBox,
                transparent: p.transparent, diggable: p.diggable, material: p.material,
                harvestTools: p.harvestTools, drops: p.drops, _properties: p._properties,
                isWaterlogged: p.isWaterlogged,
            };
        },

        // BORROWED shell — VALID ONLY UNTIL THE NEXT READ. See the header. Never call this from anything
        // that keeps the block, or the `position` it keeps will be rewritten under it by the next read.
        borrowBlockAt(x, y, z) {
            const s = stateIdAt(x, y, z);
            if (s < 0) return null;
            const sh = table.shell(s);
            if (!sh) return null;
            const p = sh.position;
            p.x = x; p.y = y; p.z = z;
            return sh;
        },

        // ── (3) THE FLAGS PATH ──────────────────────────────────────────────────────────────────────
        // Byte-for-byte the same verdict as pathfinding_utils.classifyFloorInline: isFloorSafe IS
        // terrain_predicates.isWalkableSurface (the WALKABLE bit) and the clearance test IS
        // isBlockPassable (the PASSABLE bit). No block object is built at any point.
        //
        // `floorStateId` is the caller's own already-read number for (x,y,z), not a cache. Passing it
        // skips a redundant re-read of a cell the caller just read; omitted, the floor is read normally.
        classifyFloorAt(x, y, z, floorStateId) { return classify(reader, x, y, z, floorStateId); },

        get statesSeen() { return table.size; },
        resetStats() { stats.reads = 0; stats.unloaded = 0; stats.columnHits = 0; stats.columnMisses = 0; stats.memoHits = 0; stats.memoMisses = 0; },

        // ONE SEARCH = ONE WORLD. Called at the top of a search to drop the previous search's answers and
        // set the origin the keys pack against. Production's _fastVoxelView already builds a fresh reader
        // per computeAStar call, so the natural lifetime is correct there without any call at all; this
        // exists so a bench can reuse ONE reader across trials and still measure per-search behaviour.
        beginSearch(originX, originY, originZ) {
            if (memo) memo.clear();
            ox = originX | 0; oy = originY | 0; oz = originZ | 0;
        },
        get memoSize() { return memo ? memo.size : 0; },

        // Law 8: the listeners are raised by this reader and must not outlive it. Benches exit, but a
        // fleet-side adoption would leak one pair per reader without this.
        dispose() { w.removeListener('chunkColumnUnload', onColumnChange); w.removeListener('chunkColumnLoad', onColumnChange); },
    };
    return reader;
}

// Shared by both paths so the fast and worldless readers cannot drift into different verdicts.
function classify(r, x, y, z, floorStateId) {
    const f = floorStateId === undefined ? r.flagsAt(x, y, z)
        : (floorStateId < 0 ? UNLOADED : tableFor(r._version).flags(floorStateId));
    if (f === UNLOADED || (f & F.WALKABLE) === 0) return null;
    let clear = 0;
    for (let i = 1; i <= 3; i++) {
        const a = r.flagsAt(x, y + i, z);
        if (a === UNLOADED || (a & F.PASSABLE) === 0) break;
        clear++;
    }
    return clear >= 3 ? 'jumpable' : clear >= 2 ? 'walkable' : null;
}

module.exports = { makeVoxelReaderV2, FLAGS: F, UNLOADED };
