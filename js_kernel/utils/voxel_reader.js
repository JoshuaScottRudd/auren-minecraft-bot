// voxel_reader — the one way to read voxels in bulk. A caller declares what it needs to know and gets
// back the cheapest reader that honestly answers it (Law 16: one pathway, correctly parameterized).
//
// Minecraft stores a number at every position; that number identifies one block. `bot.blockAt` answers
// "what number is here" and then builds a ~20-field description around it — light, sky light, biome,
// hardness, harvest tools, drops, collision shapes, metadata — on every call, a cost a wide sweep or a
// large search pays far more times than there are distinct kinds of block to describe.
//
// Almost every scan in the fleet reads only `name` and `boundingBox`. Those are functions of the number
// alone, so they can be computed once per number and looked up forever after; the per-position fields
// cannot. Declaring needs is what lets one API serve both without guessing: ask for type and you get the
// fast path; ask for light and you get the full read, the only honest way to answer.
//
// Two tables live here and only one is memoized:
//     position -> number      changes constantly. Never cached. Read live on every single call.
//     number   -> what it is  never changes. It is a fact about Minecraft, not about the world.
// Mining a block changes only the number at its position, so the next read there returns the new number
// with no invalidation step, because nothing position-keyed was ever stored.
//
// A need this module cannot serve from the number returns the full reader, and says so via `.fast` (Law
// 25) — it must never quietly answer a light-level question from the type table, the well-formed
// falsehood Law 26 names. Callers that care can assert on `.fast`.

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
// pure function of the number.
const TYPE_DERIVABLE = new Set(['type', 'name', 'boundingBox', 'diggable', 'shapes', 'walkable', 'passable', 'solid', 'water']);

// The per-number table. Verdicts are produced by calling the real predicates, never by copying the
// block-name lists behind them — a copied membership set is a second definition of the same question
// that can drift silently, here into routing a body through a wall. Derive, never transcribe.
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

// How many reads a reader may take before it re-reads the spawn latch. Bounded staleness with no per-read
// cost: the latch lands during login, long before any scan, and the chunk-change hook below refreshes on
// every move as well — so this only matters for a reader that sits still through a `/setworldspawn`.
const MASK_RECHECK_READS = 4096;

// The spawn mask, held as four numbers per reader (Law 16 — the rule is spawn_protection's; only the
// arithmetic is copied here, and only because of where it is asked).
//
// This is the read path: one A* search asks it hundreds of thousands of times against a 0.25s deadline, so
// a module call per read is not affordable and an allocation per read is fatal. The square changes at most
// twice in a run (the packet, and a `/setworldspawn`), so the bounds are cached and re-read only when
// spawn_protection's integer latch version moves. Lazily required: this is a leaf utility and
// spawn_protection pulls in the watcher and the config, which would close a load-time cycle through
// pathfinding_utils.
//
// It follows the door, not the process: `spawn_protection.maskWorldReads(bot)` is the one place a body is
// enrolled, and this path answers to that same enrolment — a mask keyed only on the latch would mask every
// reader in the process, including bodies that never asked. Two bodies arm the latch without being masked:
// the operator's own proxy, a person who must see the real world, and any bench holding a body to measure
// one. `_spawnMaskInstalled` is the flag `maskWorldReads` sets, so the two doors open and close together
// (Law 16), re-read on the same schedule as the bounds, since enrolment happens at login and a reader
// built before it must not cache "unmasked" for the rest of the run.
let _spawnProtection = null;
function makeMask(bot) {
    const m = { version: -1, enrolled: false, on: false, minX: 0, maxX: 0, minZ: 0, maxZ: 0, stateId: -1 };
    m.refresh = () => {
        if (!_spawnProtection) _spawnProtection = require('@perception/spawn_protection');
        const enrolled = !!bot._spawnMaskInstalled;
        const v = _spawnProtection.latchVersion();
        if (v === m.version && enrolled === m.enrolled) return;
        m.version = v; m.enrolled = enrolled;
        const box = enrolled ? _spawnProtection.spawnProtectionBox(bot) : null;
        m.on = !!box;
        if (!box) return;
        m.minX = box.minX; m.maxX = box.maxX; m.minZ = box.minZ; m.maxZ = box.maxZ;
        m.stateId = _spawnProtection.maskStateId(bot);
    };
    return m;
}

let _tables = null;   // keyed per mc version, though the fleet runs one
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
            // Derived by calling gravity_utils' own predicate against the prototype, same rule as every
            // flag above. It takes a bot and reads for itself, so it is handed a bot that answers with
            // this one block — that keeps the source-vs-flowing distinction owned by gravity_utils, not
            // re-encoded here as a bare state id that could silently drift when a version renumbers the
            // palette.
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
    // One authored answer: `master_core` creates the bot with `version: SERVER_MINECRAFT_VERSION`, so
    // mineflayer never negotiates and `bot.version` is that same constant arriving by a second path — a
    // value that decides how every voxel in the world is decoded needs exactly one source (Invariant B).
    // `opts.version` stays as a genuine authored override — the benches pass `--version` to read a
    // snapshot taken under a different build.
    const version = opts.version || require('@thinking/architect_config').SERVER_MINECRAFT_VERSION;
    const unmet = needs.filter(n => !TYPE_DERIVABLE.has(n));
    const stats = { reads: 0, unloaded: 0, columnHits: 0, columnMisses: 0 };
    // A caller may hand us something that is not a live mineflayer bot — the virtual playground's bot, a
    // bench adapter, lanista's four-field stub. Those answer blockAt and nothing else, so the number
    // table has no column to read from. Checked here, at construction: a reader that reports `fast` and
    // then throws on its first read would fail far from its cause.
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
            // The body's own wrapper masks this path already (`spawn_protection.maskWorldReads`); the call
            // is left plain so there is one masking site per read path and not two answering in sequence.
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

    // `col` is not a copy: it is mineflayer's own ChunkColumn, the object the server's block updates are
    // written into, so holding it cannot produce a stale block. What is held is the handle, never a
    // verdict about a cell — a search or a sweep asks about the same 16x16 column many times running, so
    // holding the handle across those lookups replaces a string key plus a Map hash plus two Vec3
    // allocations with a single integer comparison.
    let cx = 0x7fffffff, cz = 0x7fffffff, col = null;

    // One scratch vector per reader, mutated in place — safe because ChunkColumn.getBlockStateId reads
    // x/y/z, converts them to a section index and an integer offset, and retains no reference. Kept
    // per-reader so two bots in one process cannot interleave into each other's scratch.
    const scratch = new Vec3(0, 0, 0);

    // A held handle goes bad on identity, not staleness of block data (impossible — the object is live):
    // on unload mineflayer drops the column from the world, and a reader still holding it would report
    // never-sensed space as solid terrain, the verdict Law 23 forbids most. computeAStar yields to the
    // cooperative pacer mid-search, so an unload can land between two reads of one search.
    //
    // The mask's bounds ride along with the held column: both are per-reader state that a move can
    // invalidate, and a chunk edge is the cheapest moment in the run to re-read a latch that changes twice.
    // The read counter below is the backstop for a reader that never crosses one.
    const mask = makeMask(bot);
    mask.refresh();
    let sinceMaskCheck = 0;

    const onColumnChange = () => { cx = 0x7fffffff; cz = 0x7fffffff; col = null; mask.refresh(); };
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
            // THE SPAWN MASK IS READ HERE AND NOT ONLY ON THE BODY, because this path never calls
            // bot.blockAt: it reads mineflayer's ChunkColumn directly, so the body's wrapper cannot see it.
            // One answer, two paths (Law 16) — a masked cell is the same block whichever door asked.
            if (++sinceMaskCheck > MASK_RECHECK_READS) { sinceMaskCheck = 0; mask.refresh(); }
            if (mask.on && x >= mask.minX && x <= mask.maxX && z >= mask.minZ && z <= mask.maxZ) return mask.stateId;
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
        // second entry point: the caller passes the floor cell's own already-read state id, so A* (which
        // always holds it) need not spend a second read on that cell. Omit it and the floor is read
        // normally.
        //
        // Answers identically to pathfinding_utils.classifyFloorInline by derivation, not by copying:
        // isFloorSafe is terrain_predicates.isWalkableSurface (the WALKABLE bit) and the clearance test is
        // isBlockPassable (the PASSABLE bit) — the same two predicates the flag table calls to build them.
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
