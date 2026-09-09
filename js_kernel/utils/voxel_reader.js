// voxel_reader — the ONE way to read voxels in bulk. A caller declares WHAT IT NEEDS TO KNOW and gets
// back the cheapest reader that honestly answers it (Law 16: one pathway, correctly parameterized).
//
// ── WHY DECLARING NEEDS IS THE WHOLE DESIGN ────────────────────────────────────────────────────────
// Minecraft stores a NUMBER at every position; that number identifies one block. `bot.blockAt` answers
// "what number is here" and then builds a ~20-field description around it — light, sky light, biome,
// hardness, harvest tools, drops, collision shapes, metadata — on EVERY call. That per-call cost is
// paid needlessly at scale: a wide sweep or a large search calls it far more times than there are
// distinct kinds of block to describe.
//
// Almost every scan in the fleet reads only `name` and `boundingBox`. Those are functions of the number
// alone, so they can be computed ONCE per number and looked up forever after. The per-position fields
// cannot. Declaring needs is what lets one API serve both without guessing: ask for TYPE and you get the
// fast path; ask for light and you get the full read, because that is the only honest way to answer.
//
// ── WHAT NEVER GETS CACHED, AND WHY THE STALENESS WORRY DOES NOT APPLY ─────────────────────────────
// Changing a block changes only the number at its position; there are two tables here and only one is
// memoized:
//     position -> number      changes constantly. NEVER cached. Read live on every single call.
//     number   -> what it is  never changes. It is a fact about Minecraft, not about the world.
// Mine a block and that position returns a different number on the very next read, with no invalidation
// step, because nothing position-keyed was ever stored.
//
// ── THE FALLBACK IS LOUD, NOT SILENT (Law 25) ──────────────────────────────────────────────────────
// A need this module cannot serve from the number returns the FULL reader, and says so via `.fast`.
// It must never quietly answer a light-level question from the type table — that would be a well-formed
// falsehood, the exact failure Law 26 names. Callers that care can assert on `.fast`.

'use strict';

const Vec3 = require('vec3');
const pf = require('@utils/pathfinding_utils');
const { isWalkableSurface } = require('@utils/movement/terrain_predicates');
const { isWaterSource } = require('@utils/gravity_utils');
const { STATION_TYPES } = require('@utils/fragment_utils');
const { guardExternalSync } = require('@utils/external_library_guard');

// ── NEEDS ───────────────────────────────────────────────────────────────────────────────────────────
// Everything derivable from the number alone. A need outside this set forces the full read.
// 'type' is the umbrella most scans want: name + boundingBox + diggable + shapes.
// 'water' earns its place here because water level is encoded in the state id itself: source vs.
// flowing water differ by state id, not by any per-position field, so "is this a source block" is a
// pure function of the number. Without it the wheat scanner would have had to keep a full read for its
// one water question, which is most of its scan.
const TYPE_DERIVABLE = new Set(['type', 'name', 'boundingBox', 'diggable', 'shapes', 'walkable', 'passable', 'solid', 'water']);

// ── The per-number table. Verdicts are produced by CALLING the real predicates, never by copying the
// block-name lists behind them. A copied membership set is the failure pathfinding_utils' own
// SCAFFOLD_BLOCKS comment records — "what is a placeable block" defined in five places, one canonical —
// and here the drift would not throw, it would route a body through a wall. Derive, never transcribe.
const F = {
    WALKABLE: 1 << 0, PASSABLE: 1 << 1, SOLID: 1 << 2, FULL_HEIGHT: 1 << 3,
    LEAF: 1 << 4, DOOR: 1 << 5, SCAFFOLD: 1 << 6, STATION: 1 << 7, KNOWN: 1 << 8,
    WATER_SOURCE: 1 << 9,
};
// Unloaded is an ABSENCE OF KNOWLEDGE, never a fact about the world, so it cannot share a value with
// "nothing is true here" (which reads identically to air). bot.world.getBlockStateId returns 0 for an
// unloaded column — reading state ids without distinguishing this reports never-seen chunks as open sky,
// and a search would plan confident routes through them (Law 23).
const UNLOADED = -1;

let _tables = null;   // per mc version; the fleet runs one, but keyed anyway rather than assumed
function tableFor(version) {
    if (!_tables) _tables = new Map();
    let t = _tables.get(version);
    if (t) return t;
    const Block = require('prismarine-block')(version);
    const flags = [];
    const protos = [];
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
            // Derived by CALLING gravity_utils' own predicate against the prototype, same rule as every
            // flag above. It takes a bot and reads for itself, so it is handed a bot that answers with
            // this one block — that keeps the source-vs-flowing distinction owned by gravity_utils
            // rather than re-encoded here as "state id 86", which is exactly the transcription that
            // would silently drift when a version renumbers the palette.
            if (isWaterSource({ blockAt: () => b }, 0, 0, 0)) f |= F.WATER_SOURCE;
            flags[stateId] = f;
            return f;
        },
        proto(stateId) {
            let p = protos[stateId];
            if (p !== undefined) return p;
            // prismarine-block throws on a state id this version does not know; null is the answer
            // the classifier below already handles.
            p = guardExternalSync('voxel_reader', `Block.fromStateId(${stateId})`, () => Block.fromStateId(stateId, 0)).value ?? null;
            if (p) p.position = new Vec3(0, 0, 0);   // the real predicates read it during classification
            protos[stateId] = p;
            return p;
        },
        get size() { return protos.filter(Boolean).length; },
    };
    _tables.set(version, t);
    return t;
}

// makeVoxelReader(bot, opts) -> reader
//   opts.needs   — array of what the caller must know. Default ['type'].
//   opts.version — mc version for the block registry. Default from the bot.
//
// The returned reader always exposes `blockAt(x, y, z)` returning a block-shaped object or null, so it
// drops into any existing scan. `.fast` reports which path it took — true = type table, false = full read.
function makeVoxelReader(bot, opts = {}) {
    const needs = opts.needs || ['type'];
    const version = opts.version || bot?.version || '1.21.5';
    const unmet = needs.filter(n => !TYPE_DERIVABLE.has(n));
    const stats = { reads: 0, unloaded: 0, columnHits: 0, columnMisses: 0 };
    // A caller may hand us something that is not a live mineflayer bot — the virtual playground's bot, a
    // bench adapter, lanista's four-field stub. Those answer blockAt and nothing else, so the number
    // table has no column to read FROM. This is checked at CONSTRUCTION rather than left to blow up on
    // the first read: a reader that reports `fast` and then throws would fail far from its cause, and a
    // scan that works live but dies headless is the exact defect the bench exists to catch first.
    const hasWorld = typeof bot?.world?.getColumnAt === 'function';

    // ── SLOW PATH. Chosen, not fallen into: some field the number cannot answer was asked for (or there
    // is no chunk store to read numbers from), so the only truthful answer is the full read. Same
    // counting surface so callers are measured alike.
    if (unmet.length > 0 || !hasWorld) {
        const slow = {
            fast: false,
            _version: version,
            unmetNeeds: unmet,
            worldless: !hasWorld,
            blockAt(x, y, z) { stats.reads++; const b = bot.blockAt(new Vec3(x, y, z)); if (!b) stats.unloaded++; return b; },
            flagsAt(x, y, z) { const b = slow.blockAt(x, y, z); return b ? tableFor(version).flags(b.stateId) : UNLOADED; },
            stats, FLAGS: F, UNLOADED,
            get statesSeen() { return tableFor(version).size; },
            resetStats() { stats.reads = 0; stats.unloaded = 0; stats.columnHits = 0; stats.columnMisses = 0; },
            dispose() {},   // no listeners on this path; present so callers need not branch (Law 8)
        };
        Object.assign(slow, derived(slow));
        return slow;
    }

    // ── FAST PATH. The column lookup is NOT an optimization detail and must not be replaced with
    // bot.world.getBlockStateId: that returns 0 (air) for an unloaded column, silently turning "I have
    // never seen this chunk" into "this is open sky".
    const table = tableFor(version);

    // ── THE HELD COLUMN ──────────────────────────────────────────────────────────────────────────────
    // `col` is NOT a copy of anything: it is mineflayer's own ChunkColumn — the object the server's
    // block updates are written INTO — so holding it cannot produce a stale block. What is held is the
    // HANDLE, never a verdict about a cell. Caching a derived verdict per cell instead does not pay:
    // once the read itself is this cheap, the read stops being what costs, so pre-computing verdicts
    // does not measurably speed anything up.
    //
    // A search or a sweep asks about the same 16x16 column many times running, so holding the column
    // handle across those repeated lookups replaces a string key plus a Map hash plus two Vec3
    // allocations with a single integer comparison.
    let cx = 0x7fffffff, cz = 0x7fffffff, col = null;

    // One scratch vector per reader, mutated in place. Safe because ChunkColumn.getBlockStateId reads
    // x/y/z, converts them to a section index and an integer offset, and retains no reference. Per-reader
    // rather than per-module so two bots in one process cannot interleave into each other's scratch.
    const scratch = new Vec3(0, 0, 0);

    // THE ONE WAY A HELD HANDLE CAN GO BAD, and it is not staleness of block data (impossible — the
    // object is live). It is IDENTITY: on unload mineflayer drops the column from the world, and a reader
    // still holding it would answer from a region the bot can no longer see — reporting never-sensed
    // space as solid terrain, the verdict Law 23 forbids most. It matters concretely because computeAStar
    // YIELDS to the cooperative pacer mid-search, so an unload genuinely can land between two reads of
    // one search.
    const onColumnChange = () => { cx = 0x7fffffff; cz = 0x7fffffff; col = null; };
    const world = bot.world;
    world.on('chunkColumnUnload', onColumnChange);
    world.on('chunkColumnLoad', onColumnChange);

    const fast = {
        fast: true,
        _version: version,
        unmetNeeds: [],
        worldless: false,
        stats, FLAGS: F, UNLOADED,
        stateIdAt(x, y, z) {
            stats.reads++;
            const qx = x >> 4, qz = z >> 4;   // arithmetic shift: correct for negatives, unlike /16|0
            if (qx !== cx || qz !== cz) {
                stats.columnMisses++;
                col = world.getColumn(qx, qz);
                cx = qx; cz = qz;
            } else {
                stats.columnHits++;
            }
            if (!col) { stats.unloaded++; return -1; }
            scratch.x = x & 15; scratch.y = y; scratch.z = z & 15;
            return col.getBlockStateId(scratch);
        },
        flagsAt(x, y, z) { const s = fast.stateIdAt(x, y, z); return s < 0 ? UNLOADED : table.flags(s); },
        // A block-shaped object for callers that still want one. ONE object literal, fixed key order, so
        // every value shares a hidden class and downstream `.name` reads stay monomorphic — that
        // monomorphism IS the speed. Building it in two branches, or adding a conditional key,
        // reintroduces the polymorphism this exists to avoid and the gain silently reverts.
        blockAt(x, y, z) {
            const s = fast.stateIdAt(x, y, z);
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
        get statesSeen() { return table.size; },
        resetStats() { stats.reads = 0; stats.unloaded = 0; stats.columnHits = 0; stats.columnMisses = 0; },
        // Law 8: these listeners are raised by this reader and must not outlive it. The WeakMap holders
        // (surface_filter) drop the reader with the bot; a caller that builds one per call must dispose.
        dispose() { world.removeListener('chunkColumnUnload', onColumnChange); world.removeListener('chunkColumnLoad', onColumnChange); },
    };
    Object.assign(fast, derived(fast));
    return fast;
}

// The composite questions, defined ONCE over whichever path was chosen so both answer identically.
//
// PER-NUMBER vs PER-PLACE, and the split is load-bearing: isWalkable is a property of the block, so it
// comes straight from the table. classifyFloor is NOT — it asks whether the three cells ABOVE are clear,
// which is four positions and changes the instant any of them changes. It is therefore composed live
// from four lookups on every call and never stored. Mirrors pathfinding_utils.classifyFloorInline
// exactly: safe floor + 3 clear = 'jumpable', + 2 clear = 'walkable', else null.
function derived(r) {
    const has = (x, y, z, bit) => { const f = r.flagsAt(x, y, z); return f !== UNLOADED && (f & bit) !== 0; };
    return {
        isWalkable: (x, y, z) => has(x, y, z, F.WALKABLE),
        isPassable: (x, y, z) => has(x, y, z, F.PASSABLE),
        isSolid:    (x, y, z) => has(x, y, z, F.SOLID),
        isWaterSource: (x, y, z) => has(x, y, z, F.WATER_SOURCE),
        classifyFloor(x, y, z) {
            if (!has(x, y, z, F.WALKABLE)) return null;
            let clear = 0;
            for (let i = 1; i <= 3; i++) { if (!has(x, y + i, z, F.PASSABLE)) break; clear++; }
            return clear >= 3 ? 'jumpable' : clear >= 2 ? 'walkable' : null;
        },
        // classifyFloorAt — the same verdict as classifyFloor, plus the one thing that makes it worth a
        // second entry point: the caller passes the floor cell's OWN already-read state id. A* always
        // holds it (it read the block to get here), so re-reading that cell would add one read per call
        // and make the flags path cost more than the block path it replaces. Omit it and the floor is
        // read normally.
        //
        // It answers identically to pathfinding_utils.classifyFloorInline by DERIVATION, not by copying:
        // isFloorSafe IS terrain_predicates.isWalkableSurface (the WALKABLE bit) and the clearance test IS
        // isBlockPassable (the PASSABLE bit) — the same two predicates the flag table calls to build them.
        // A drift here does not throw — it plans a different route, silently. Nothing currently enforces
        // this agreement automatically; a load-time throw sampling a handful of known state ids through
        // both paths would.
        classifyFloorAt(x, y, z, floorStateId) {
            const ff = floorStateId === undefined ? r.flagsAt(x, y, z)
                : (floorStateId < 0 ? UNLOADED : tableFor(r._version).flags(floorStateId));
            if (ff === UNLOADED || (ff & F.WALKABLE) === 0) return null;
            let clear = 0;
            for (let i = 1; i <= 3; i++) { if (!has(x, y + i, z, F.PASSABLE)) break; clear++; }
            return clear >= 3 ? 'jumpable' : clear >= 2 ? 'walkable' : null;
        },
    };
}

module.exports = { makeVoxelReader, FLAGS: F, UNLOADED, TYPE_DERIVABLE };
