// assessors/downloaded_build — the whole ladder for a DOWNLOADED building, in one assessor.
//
// ── TWO PHASES ───────────────────────────────────────────────────────────────────────────────────────
// Trees come down, then the anchors go up: no scrape, no basement, no stair seal. The anchors cover
// every cell of the blueprint's box (blueprint_anchor_calculator's header); a cell the download leaves
// empty is an air target, so the ground standing inside the box is cleared by the same pass that builds
// the walls — bottom-up, one cube at a time. The way down to a column's foot is navigation's to find (a
// straight diagonal stair and a tunnel under the box), and whatever that leaves is the basement.
//
// The two phases are one ladder with one owner (Invariant D) — `assessors/building` owns the
// headframe's for the same reason — and exactly one is live at a time.
//
// ── THE ORDER IS THE BUILDING'S, NOT THE BOARD'S ────────────────────────────────────────────────────
// Each column offers exactly ONE cube: its lowest unfinished one, since a cube above an unfinished one
// cannot be reached without leaving the shaft. Every offered cube carries `build_order` — its layer,
// then its column number — and the dispatcher takes the lowest open number among the jobs this pool
// can pay for. The lowest layer holding a workable cube is posted (the open layer), and the layer above it once
// every posted cube below is held by a body.
//
// ── ONE CUBE PER TRIP ───────────────────────────────────────────────────────────────────────────────
// A job is one cube, so a body never carries a full inventory between anchors. The top cube's trip is
// the one that also restores the stand column on the way down, so its order carries the descent's
// blocks too.
//
// ── THE WORLD IS THE PROGRESS LEDGER, WITH ONE REMEMBERED FACT ──────────────────────────────────────
// Which cube is next is read off the world every sweep: a cube is finished when every cell it owns,
// stand column excepted, holds what the plan asks (air where the plan has nothing). What IS remembered
// is that a cube was once seen finished, only to bound the cost — a large build can run to hundreds of
// cubes and tens of thousands of cells, and reading them all on every sweep of a whole crew is the
// whole machine's time. A finished cube can only change if a block falls into it (sand, gravel from the
// unbuilt ground above), since the box is closed to every other dig; so a handful of remembered cubes
// are re-read every sweep in rotation, and one found wrong is forgotten and offered again.

'use strict';

const Vec3 = require('vec3');
const pace = require('@utils/execution_yield').makeExecutionPacer();
const hq = require('@kernel/corporate_headquarters');
const planRegistry = require('@kernel/downloaded_plan_registry');
const { cubeCells, ENTRY_FEET_BELOW, CUBE } = require('@kernel/blueprint_anchor_calculator');
const { currentMode } = require('@kernel/bot_mandate');
const { isAir } = require('@utils/movement/terrain_predicates');

const inventoryLens = require('@kernel/inventory_lens');
const watcher = require('@kernel/watcher');
const { itemsFor } = require('@kernel/blueprint_importer');
const { remainingRawInSpecies, familyBalance, familyRoot } = require('@utils/calculators/build_material_calculator');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { getBotInventory, homeChest, isUnderground } = require('@utils/fragment_utils');

const { JOB_TYPE, BOT_MODES } = require('@thinking/architect_config');
const { TAG, deliverScope, supplyJob, planTreeBox, siteTreePhaseDone, siteTreesJob } = require('@thinking/assessors/shared');

const trash = require('@utils/trash');
// How many paid-for cubes are posted as jobs each sweep, and how many bodies' trash the window's order carries.
// The dispatcher takes the lowest open number, so a crew of twenty takes at most twenty; the rest of the margin
// covers cubes peers already hold.
const PRICED_PER_SWEEP = 32;
// How many remembered-finished cubes are re-read each sweep, oldest first (see the header).
const REVERIFIED_PER_SWEEP = 8;

// The one place the run's build name comes from. A crew that is not a builder has none, and every
// question below answers "nothing to do" for it, never a guessed structure.
function buildName() {
    if (currentMode() !== BOT_MODES.BUILDER) return null;
    return require('../../foreman_config').builder?.build || null;
}

// The locked row the foreman wrote when it sited the building, or null while it has not.
function sitedRow(name) {
    const spot = hq.readBuildingChair(name, 'set_buildspot');
    return (spot && spot.transpose_origin && typeof spot.transpose_origin.x === 'number') ? spot : null;
}

// ── WHAT EACH CUBE OWNS ─────────────────────────────────────────────────────────────────────────────
// targetsOf(anchor) → [{ b:[x,y,z], v }] for every in-box cell of the cube except the stand column, where `v`
// is the plan's voxel or null for an air target. A bounded cache retains these pure plan-derived lists;
// an evicted list is reconstructed from the run's immutable plan snapshot.
const memoryWorkspace = require('@utils/memory_workspace');
const _targetCache = new Map();
let _cachedCells = 0;
function trimTargets(limit) {
    while (_cachedCells > limit && _targetCache.size) {
        const key = _targetCache.keys().next().value;
        _cachedCells -= _targetCache.get(key).length;
        _targetCache.delete(key);
    }
}
memoryWorkspace.onRelease(trimTargets);
// Pure plan-derived lists can be reconstructed exactly; eviction changes cost, never world knowledge.
function cachedTargets(key) {
    if (memoryWorkspace.enabled()) trimTargets(memoryWorkspace.budget().cacheCells);
    const value = _targetCache.get(key);
    if (value) { _targetCache.delete(key); _targetCache.set(key, value); }
    return value;
}
function keepTargets(key, value) {
    const limit = memoryWorkspace.enabled() ? memoryWorkspace.budget().cacheCells : Infinity;
    if (value.length > limit) return;
    trimTargets(limit - value.length);
    _targetCache.set(key, value);
    _cachedCells += value.length;
}
function targetsOf(anchor) {
    const key = `cube:${anchor.index}`;
    let t = cachedTargets(key);
    if (t) return t;
    const dims = planRegistry.dimensions();
    const byCell = new Map(anchor.voxels.map(v => [`${v[0]},${v[1]},${v[2]}`, v]));
    t = [];
    for (const [x, y, z] of cubeCells(anchor, dims)) {
        if (x === anchor.stand[0] && z === anchor.stand[2]) continue;   // restored on the column's last descent
        t.push({ b: [x, y, z], v: byCell.get(`${x},${y},${z}`) || null });
    }
    keepTargets(key, t);
    return t;
}

// shaftTargets(column) → the stand column's own cells over the whole box, top first, each with its voxel or null.
// The descent list carries only the voxels; the air targets between them are cells the descent must dig clear.
function shaftTargets(column) {
    const key = `shaft:${column.column}`;
    let t = cachedTargets(key);
    if (t) return t;
    const dims = planRegistry.dimensions();
    const byY = new Map(column.descent.map(v => [v[1], v]));
    t = [];
    for (let y = dims.h - 1; y >= 0; y--) t.push({ b: [column.stand[0], y, column.stand[1]], v: byY.get(y) || null });
    keepTargets(key, t);
    return t;
}

// cellState — one owned cell against its target: 'ok' | 'wrong' | 'unseen'. An unloaded cell is UNSEEN, never
// ok: calling it finished would remember a cube nobody has looked at (and the memory is the one thing here that
// is not re-derived every sweep).
function cellState(bot, frame, t) {
    const p = frame.worldOf(t.b[0], t.b[1], t.b[2]);
    const at = bot.blockAt(new Vec3(p.x, p.y, p.z));
    if (!at || !at.name) return 'unseen';
    if (!t.v) return isAir(at.name) ? 'ok' : 'wrong';
    return frame.holds(t.v, at) ? 'ok' : 'wrong';
}

// allCorrect — early exit on the first cell that is not ok.
function allCorrect(bot, frame, targets) {
    for (const t of targets) if (cellState(bot, frame, t) !== 'ok') return false;
    return true;
}

// ── A CUBE WITH NOTHING THAT CAN BE DONE YET ────────────────────────────────────────────────────────
// workable(bot, frame, anchor) → can a trip to this cube move one block now? A cell is workable when it is
// unseen (only a trip there can read it), when it holds something to dig, or when it is empty and a trip places
// its block — on a face that stands, or on trash the trip stands for it (build_column_executor.escalate). The
// cells a trip leaves are a block that hangs and waits for its support (waitsOnSupport), the free half of a
// two-cell piece, and a block whose state can only be clicked onto the climbing shaft (the shaft is open until
// the column's last descent, and no trash stands in it); a cube with only those open is passed over and read
// again every sweep.
async function workable(bot, frame, anchor) {
    const mc = require('minecraft-data')(bot.version);
    for (const t of targetsOf(anchor)) {
        const state = cellState(bot, frame, t);
        if (state === 'ok') continue;
        if (state === 'unseen') return true;
        const p = frame.worldOf(t.b[0], t.b[1], t.b[2]);
        if (!isAir(bot.blockAt(new Vec3(p.x, p.y, p.z)).name)) return true;   // something to dig
        if (await waitsOnSupport(bot, frame, anchor, t)) continue;
        const block = frame.blockOf(t.v[3], t.v[1]), plan = frame.stateOf(t.v[4]);
        if (!itemsFor(block, plan, mc).length) continue;
        if (!plan) return true;
        // A click cell serves when it stands now, or when trash can stand in it: any cell off the shaft.
        const at = new Vec3(p.x, p.y, p.z);
        const shaftCells = (await owners()).shaft;
        const serves = (cell) => {
            const here = bot.blockAt(cell);
            if (here && here.boundingBox === 'block') return true;
            const o = frame.worldOf(0, 0, 0);
            return !shaftCells.has(`${cell.x - o.x},${cell.y - o.y},${cell.z - o.z}`);
        };
        if (require('@utils/movement/facing_aim').clickCells(bot, at, block, plan).some(serves)) return true;
    }
    return false;
}

// ── A BLOCK THAT HANGS WAITS FOR THE BLOCK IT HANGS ON ────────────────────────────────────────────────
// waitsOnSupport(bot, frame, anchor, t) → true when the cell's block drops without its support (a lantern, a
// torch, a sign, a ladder, a button: support_plan.hangs) and no cell it may hang on will hold the plan's block by
// the time this trip places it. Such a block is left out of the trip whole: not ordered, not tried, not counted
// as a failure. It is read again on every sweep and at the start of every trip, so it goes in on the first trip
// after the cube that owns its support has placed it.
//
// A support counts when it is: ground outside the box showing a full block; another cube's cell already holding
// what the plan asks; or a full block of this same cube, which this trip places. A support in a stand column
// never counts: the climb digs that column open on every trip and puts it back only when the whole column is
// done, so whatever stands there during a trip is the body's own filler, and a block hung on it falls with it.
async function waitsOnSupport(bot, frame, anchor, t) {
    if (!t.v) return false;
    const { hangs, supportCells } = require('@kernel/support_plan');
    const block = frame.blockOf(t.v[3], t.v[1]);
    const state = frame.stateOf(t.v[4]);
    if (!hangs(block, state)) return false;
    const cells = supportCells(t.b, block, state);
    if (!cells) return false;
    const mc = require('minecraft-data')(bot.version);
    const full = (name) => { const b = mc.blocksByName[name]; return !!b && b.boundingBox === 'block'; };
    const { cube, shaft } = await owners();
    for (const c of cells) {
        const key = c.join(',');
        if (shaft.has(key)) continue;
        const o = cube.get(key);
        if (!o) {
            const p = frame.worldOf(c[0], c[1], c[2]);
            const at = bot.blockAt(new Vec3(p.x, p.y, p.z));
            if (!at || !at.name || (!isAir(at.name) && at.boundingBox === 'block')) return false;
            continue;
        }
        if (!o.t.v || !full(frame.blockOf(o.t.v[3], o.t.v[1]))) continue;
        if (o.index === anchor.index || cellState(bot, frame, o.t) !== 'wrong') return false;
    }
    return true;
}

// Open cubes passed over this sweep because nothing in them can be moved yet, said when the count changes
// (accounting_lens CUBES_WAITING).
let _waiting = null;
function noteWaiting(n) {
    if (n === _waiting) return;
    _waiting = n;
    watcher.summary(TAG, `CUBES_WAITING n=${n}`);
}

// ── WHAT EACH WAITING CUBE WAITS ON ─────────────────────────────────────────────────────────────────
// A waiting cube's open cells are each read against their six neighbours: a neighbour the plan puts a block in
// and the world holds air in is what the cell waits on, named by who places it — the stand column of a column
// (placed on that column's last descent), or another cube with what that cube is doing this sweep (posted,
// short of a material, waiting itself, past the priced window, or not its column's turn) and whether it lies
// above, below or beside. A cell whose plan neighbours all stand waits on the click (its state has no usable
// face from the stand); a cell with no plan neighbour at all waits on a support. Read on its own clock and said
// per cube when it changes, with one total (accounting_lens CUBE_WAITS, CUBES_WAITING_ON).
const WAITS_EVERY_MS = 30000;
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
let _owners = null;
async function owners() {
    if (_owners) return _owners;
    const cube = new Map(), shaft = new Map();
    for (const a of planRegistry.anchors()) {
        await pace();
        for (const t of targetsOf(a)) cube.set(t.b.join(','), { index: a.index, t });
    }
    for (const c of planRegistry.columns()) {
        await pace();
        for (const t of shaftTargets(c)) shaft.set(t.b.join(','), { column: c.column, t });
    }
    _owners = { cube, shaft };
    return _owners;
}
async function waitsOf(bot, frame, anchor, statusOf) {
    const mc = require('minecraft-data')(bot.version);
    const anchors = planRegistry.anchors();
    const { cube, shaft } = await owners();
    const missing = (t) => {
        const p = frame.worldOf(t.b[0], t.b[1], t.b[2]);
        const at = bot.blockAt(new Vec3(p.x, p.y, p.z));
        return !at || !at.name || isAir(at.name);
    };
    const on = {};
    let cells = 0;
    for (const t of targetsOf(anchor)) {
        if (!t.v || cellState(bot, frame, t) === 'ok') continue;
        if (!itemsFor(frame.blockOf(t.v[3], t.v[1]), frame.stateOf(t.v[4]), mc).length) continue;
        cells++;
        const reasons = new Set();
        let planNeighbours = 0, own = false;
        for (const [dx, dy, dz] of SIX) {
            const key = `${t.b[0] + dx},${t.b[1] + dy},${t.b[2] + dz}`;
            const s = shaft.get(key);
            if (s) {
                if (s.t.v) { planNeighbours++; if (missing(s.t)) reasons.add(`shaft:${s.column}`); }
                continue;
            }
            const c = cube.get(key);
            if (!c || !c.t.v) continue;
            planNeighbours++;
            if (!missing(c.t)) continue;
            if (c.index === anchor.index) { own = true; continue; }
            const where = anchors[c.index].layer > anchor.layer ? 'above' : anchors[c.index].layer < anchor.layer ? 'below' : 'beside';
            reasons.add(`cube:${c.index}:${statusOf(c.index)}:${where}`);
        }
        if (!reasons.size) reasons.add(own ? 'own_cell' : planNeighbours ? 'click' : 'no_neighbour');
        for (const r of reasons) on[r] = (on[r] || 0) + 1;
    }
    return { cells, on };
}
let _waitsAt = 0, _waitsTotal = null;
const _waitsSaid = new Map();   // cube → the line last said for it
async function noteWaitsOn(bot, frame, waiting, offered, finished) {
    if (Date.now() - _waitsAt < WAITS_EVERY_MS) return;
    _waitsAt = Date.now();
    const anchors = planRegistry.anchors();
    const waitingSet = new Set(waiting);
    const offer = new Map(offered.map(o => [o.anchor.index, o]));
    const statusOf = (index) => {
        if (finished.has(index)) return 'finished';
        if (waitingSet.has(index)) return 'waiting';
        const o = offer.get(index);
        if (!o || o.seal) return 'not_its_turn';
        if (o.posted) return 'posted';
        if (o.layerClosed) return 'layer_not_open';
        return o.short ? `short_${o.short.join('+')}` : 'past_window';
    };
    const kinds = {}, primary = {};
    let cells = 0;
    for (const index of waiting) {
        await pace();
        const anchor = anchors[index];
        const w = await waitsOf(bot, frame, anchor, statusOf);
        cells += w.cells;
        const byKind = {};
        for (const [reason, n] of Object.entries(w.on)) {
            const p = reason.split(':');
            const kind = p[0] === 'cube' ? `${p[2]}@${p[3]}` : p[0];
            byKind[kind] = (byKind[kind] || 0) + n;
            kinds[kind] = (kinds[kind] || 0) + n;
        }
        const top = Object.entries(byKind).filter(([k]) => k !== 'own_cell').sort((a, b) => b[1] - a[1])[0];
        if (top) primary[top[0]] = (primary[top[0]] || 0) + 1;
        const said = `CUBE_WAITS cube=${index} layer=${anchor.layer} column=${anchor.column} cells=${w.cells} on=${Object.entries(w.on).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(',') || 'none'}`;
        if (_waitsSaid.get(index) !== said) { _waitsSaid.set(index, said); watcher.summary(TAG, said); }
    }
    for (const index of [..._waitsSaid.keys()]) {
        if (waitingSet.has(index)) continue;
        _waitsSaid.delete(index);
        watcher.summary(TAG, `CUBE_WAITS cube=${index} layer=${anchors[index].layer} column=${anchors[index].column} cells=0 on=none`);
    }
    const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(',') || 'none';
    const total = `CUBES_WAITING_ON cubes=${waiting.length} cells=${cells} cells_by=${list(kinds)} cubes_by=${list(primary)}`;
    if (total !== _waitsTotal) { _waitsTotal = total; watcher.summary(TAG, total); }
}

// The remembered-finished cubes, per building, in the order they were last verified (oldest first).
const _finished = new Map();   // anchorIndex → last verified at (ms)
let _finishedFor = null;

function rememberedFinished(structure) {
    if (_finishedFor !== structure) { _finished.clear(); _finishedFor = structure; }
    return _finished;
}

// forgetFinished — this body has just read the cube at its column and it does not stand as the plan asks.
// → true when the cube was remembered as finished.
function forgetFinished(structure, index) {
    return rememberedFinished(structure).delete(index);
}

// reverify — re-read the oldest few remembered cubes; any that has gone wrong is forgotten.
function reverify(bot, frame, finished) {
    const oldest = [...finished.entries()].sort((a, b) => a[1] - b[1]).slice(0, REVERIFIED_PER_SWEEP);
    for (const [index] of oldest) {
        const anchor = planRegistry.anchors()[index];
        if (allCorrect(bot, frame, targetsOf(anchor))) finished.set(index, Date.now());
        else finished.delete(index);
    }
}

// sealable(bot, frame, column, index) → true when the cube has nothing a trip can move and every open cell of it
// waits on a block of its own column's stand shaft and on nothing else. The last descent places that shaft block
// and then the cell beside it (build_column_executor.restoreShaft), so the cube and the shaft go in together.
async function sealable(bot, frame, column, index) {
    await pace();
    const anchor = planRegistry.anchors()[index];
    if (await workable(bot, frame, anchor)) return false;
    const w = await waitsOf(bot, frame, anchor, () => 'open');
    const own = `shaft:${column.column}`;
    return w.cells > 0 && Object.keys(w.on).every(r => r === own);
}

// nextCube(column) → { anchor, seal, passed } for the column's next trip, { waiting: n, passed } when its n open
// cubes all wait on a neighbour, or null when the column is finished. `passed` is the open cubes passed over.
// The lowest cube that is not finished and has a block a trip can move (workable); with every cube finished, a seal trip if the stand column still
// needs its own blocks (a last descent that was interrupted).
async function nextCube(bot, frame, column, finished) {
    const anchors = planRegistry.anchors();
    const passed = [];                                    // open cubes below the trip's cube that wait on a neighbour
    for (const index of column.anchors) {
        await pace();
        if (finished.has(index)) continue;
        if (allCorrect(bot, frame, targetsOf(anchors[index]))) { finished.set(index, Date.now()); continue; }
        if (!await workable(bot, frame, anchors[index])) { passed.push(index); continue; }
        return { anchor: anchors[index], seal: false, passed };
    }
    // A cube whose open cells wait only on this column's own stand shaft is finished BY the last descent, so it
    // does not hold the descent back; any other waiting cube does.
    for (const i of passed) if (!await sealable(bot, frame, column, i)) return { waiting: passed.length, passed };
    // THE SEAL CLIMBS ONLY AS HIGH AS THE SHAFT IS OPEN. The descent works a shaft cell from feet two below it,
    // so the trip's stand is the lowest one that puts the feet there for the highest open cell.
    const open = shaftTargets(column).find(t => cellState(bot, frame, t) !== 'ok');   // top first
    if (!open) return passed.length ? { waiting: passed.length, passed } : null;
    // A SEAL IS OFFERED ON A LOOK AT THE COLUMN, NEVER ON THE MEMORY OF IT. The descent restores the shaft only
    // when every cube of the column stands (build_column_executor reads them all at the column), so each cube
    // this body remembers as finished is read again here; one that no longer stands is forgotten and the
    // column is walked again, which offers that cube.
    const stale = column.anchors.filter(i => finished.has(i) && !allCorrect(bot, frame, targetsOf(anchors[i])));
    if (stale.length) {
        for (const i of stale) finished.delete(i);
        watcher.summary(TAG, `CUBE_FORGOTTEN column=${column.column} cubes=${stale.join(',')} at=seal_offer`);
        return nextCube(bot, frame, column, finished);
    }
    const stands = column.anchors.map(i => anchors[i]);
    const from = stands.find(a => a.stand[1] >= open.b[1] - 2) || stands[stands.length - 1];
    return { anchor: from, seal: true, passed };
}

// ── HOW MUCH OF THE BUILDING STANDS ─────────────────────────────────────────────────────────────────
// A cube counts when the plan puts a block in it and every cell it owns stands as the plan asks; the stand
// column is the column's last descent and is no part of any cube. Said when the count changes
// (accounting_lens CUBES_FINISHED).
// The column walk reads a column only up to its next cube, so the count reads every cube itself, on its own clock.
const FINISHED_COUNT_EVERY_MS = 30000;
let _finishedSaid = null;
let _finishedCountedAt = 0;
let _finishedCount = null;
// The body's last count of finished cubes, { done, of, at }, for the foreman to read off the chair; null before the first count.
function finishedCount() { return _finishedCount; }
async function noteFinished(bot, frame, finished) {
    if (Date.now() - _finishedCountedAt < FINISHED_COUNT_EVERY_MS) return;
    _finishedCountedAt = Date.now();
    const byLayer = new Map();   // layer → [finished, with a block in the plan]
    let done = 0, of = 0;
    for (const anchor of planRegistry.anchors()) {
        await pace();
        if (!anchor.voxels.length) continue;
        const row = byLayer.get(anchor.layer) || [0, 0];
        row[1]++; of++;
        if (!finished.has(anchor.index) && allCorrect(bot, frame, targetsOf(anchor))) finished.set(anchor.index, Date.now());
        if (finished.has(anchor.index)) { row[0]++; done++; }
        byLayer.set(anchor.layer, row);
    }
    const layers = [...byLayer.entries()].sort((a, b) => a[0] - b[0]).map(([l, [d, n]]) => `${l}:${d}/${n}`).join(',');
    const said = `CUBES_FINISHED done=${done} of=${of} by_layer=${layers}`;
    _finishedCount = { done, of, at: new Date(_finishedCountedAt).toISOString() };
    if (said === _finishedSaid) return;
    _finishedSaid = said;
    watcher.summary(TAG, said);
}

// ── THE WHOLE BUILDING'S MATERIAL, IN EVERY STATE ───────────────────────────────────────────────────
// What the building still has to be handed — every cell of every cube and every stand column that does not
// stand as the plan asks — balanced against everything the fleet holds of each material, raw, smelted or
// crafted (build_material_calculator.familyBalance). The bill is read off the world on its own clock; the
// holdings are read more often, since they move with every trip. The mine's seats and the level each of the
// building's orders is chosen by are read from this one figure.
const BILL_EVERY_MS = 30000;
const BALANCE_EVERY_MS = 5000;
let _bill = null, _billAt = 0;
let _balance = null, _balanceAt = 0, _balanceSaid = null;
function castleBalance() { return _balance; }
async function readBalance(bot, frame, finished) {
    const now = Date.now();
    if (!_bill || now - _billAt >= BILL_EVERY_MS) {
        _billAt = now;
        const mc = require('minecraft-data')(bot.version);
        const bill = {};
        // A cell this body cannot see is not a cell that needs a block. A walk that meets one is no reading of
        // the building, and the last whole reading stands until the building is in sight again.
        let unseen = false;
        const add = (t) => {
            if (!t.v || unseen) return;
            const state = cellState(bot, frame, t);
            if (state === 'unseen') { unseen = true; return; }
            if (state === 'ok') return;
            for (const [item, n] of itemsFor(frame.blockOf(t.v[3], t.v[1]), frame.stateOf(t.v[4]), mc)) {
                if (!item.includes(' ')) bill[item] = (bill[item] || 0) + n;
            }
        };
        for (const anchor of planRegistry.anchors()) {
            await pace();
            if (anchor.voxels.length && !finished.has(anchor.index)) for (const t of targetsOf(anchor)) add(t);
        }
        for (const column of planRegistry.columns()) {
            await pace();
            for (const t of shaftTargets(column)) add(t);
        }
        if (!unseen) _bill = bill;
    }
    if (_balance && now - _balanceAt < BALANCE_EVERY_MS) return _balance;
    _balanceAt = now;
    _balance = familyBalance(_bill, inventoryLens.fleetHoldings());
    const said = Object.entries(_balance).filter(([, r]) => r.need >= 20).sort((a, b) => b[1].need - a[1].need).slice(0, 8)
        .map(([root, r]) => `${root}:need=${r.need},have=${r.have}(raw=${r.raw},smelted=${r.smelted},crafted=${r.crafted}),short=${r.short}`).join(' ');
    // Said when a family's short moves by a tenth of its need, so the line follows the run without filling it.
    const key = Object.entries(_balance).map(([root, r]) => `${root}:${Math.floor(10 * r.short / r.need)}`).join('|');
    if (key !== _balanceSaid) { _balanceSaid = key; watcher.summary(TAG, `FAMILY_BALANCE ${said}`); }
    return _balance;
}
// familyLevel — how full the building's supply of one material's family is, 0..1; undefined where the
// building's bill does not carry it. Every order gathered for the building states this one figure.
function familyLevel(raw) {
    const family = _balance && _balance[familyRoot(raw)];
    return family && family.need > 0 ? Math.min(1, family.have / family.need) : undefined;
}
// levelShelf — which shelf an order's level is read off and how much that shelf wants in all, so the
// dispatcher can add what peers have pledged to it: { level_key, level_need }.
function levelShelf(raw, gap, pool) {
    const root = familyRoot(raw);
    const family = _balance && _balance[root];
    if (family && family.need > 0) return { level_key: `family:${root}`, level_need: family.need };
    return { level_key: `item:${raw}`, level_need: countInInventory(raw, pool) + gap };
}
// levelOf — how full the building's supply of one ordered material is, 0..1: the family's holdings over its
// need where the bill carries it, and the pool's holdings over the order where it does not.
function levelOf(raw, gap, pool) {
    const family = familyLevel(raw);
    if (family !== undefined) return family;
    const held = countInInventory(raw, pool);
    return held / (held + gap);
}

// entryFoot — where a body stands to enter a column: under its stand, feet ENTRY_FEET_BELOW under layer 0.
function entryFoot(frame, column) {
    return frame.worldOf(column.stand[0], -ENTRY_FEET_BELOW, column.stand[1]);
}

// entryMouth — the building's one way in: the cell just outside the box on the face nearest the first column's
// stand, at the under-level. Every body comes down to this cell and walks under the box from it, so the fleet
// digs one staircase to one door, outside the blueprint.
function entryMouth(frame) {
    const [sx, sz] = planRegistry.columns()[0].stand;
    const { w, l } = planRegistry.dimensions();
    const faces = [
        { d: sx, b: [-1, sz] }, { d: w - 1 - sx, b: [w, sz] },
        { d: sz, b: [sx, -1] }, { d: l - 1 - sz, b: [sx, l] },
    ].sort((a, b) => a.d - b.d);
    return frame.worldOf(faces[0].b[0], -ENTRY_FEET_BELOW, faces[0].b[1]);
}

// cubeMaterials — every block of the BUILDING one trip still has to be handed: the item for every owned cell of
// the cube that does not already stand as the plan asks, plus — on the trip that ends the column — the stand
// column's own blocks for the descent. The trip's trash is priced beside it by trashOf.
async function cubeMaterials(bot, frame, column, anchor, withDescent, withWaiters = withDescent) {
    await pace();
    const mc = require('minecraft-data')(bot.version);
    const need = {};
    const add = (v) => {
        const block = frame.blockOf(v[3], v[1]);
        for (const [item, n] of itemsFor(block, frame.stateOf(v[4]), mc)) {
            if (item.includes(' ')) continue;     // a block with no item — the plan's own report names it
            need[item] = (need[item] || 0) + n;
        }
    };
    // A block that hangs and whose support does not stand yet is not ordered: the trip leaves it out.
    const ordered = [];
    for (const t of targetsOf(anchor)) {
        await pace();
        if (t.v && cellState(bot, frame, t) !== 'ok' && !await waitsOnSupport(bot, frame, anchor, t)) ordered.push(t);
    }
    for (const t of ordered) add(t.v);
    // THE SUPPORTS THIS CUBE MAY PLACE EARLY (support_plan, build_column_executor.escalate): for each of its
    // blocks whose support is not sure to stand first, the first helper's block where it is another cube's own
    // block. A helper that is trash is in the trip's trash (trashOf).
    const helpers = planRegistry.supportsOf(anchor.index);
    if (helpers) {
        for (const t of ordered) {
            const list = helpers.get(t.b.join(','));
            if (!list) continue;
            const h = list[0];
            if (h.kind === 'pull' && cellState(bot, frame, { b: h.at, v: h.v }) !== 'ok') add(h.v);
        }
    }
    // THE CLIMB CLEARS THE SHAFT. The body pillars up through every shaft cell from under the box to one above
    // its stand, digging what stands there — a natural stone the plan also calls stone comes back as cobblestone.
    // So every shaft block in the climb's reach is owed on the descent whatever stands in it now; only the cells
    // above it are counted by their state.
    if (withDescent) {
        for (const t of shaftTargets(column)) {
            if (t.v && (t.b[1] <= anchor.stand[1] + 1 || cellState(bot, frame, t) !== 'ok')) add(t.v);
        }
    }
    // THE BLOCKS THE DESCENT SETS AGAINST THE SHAFT: every open cell of a cube of this column that waits on the
    // shaft alone (sealable), less the ones this cube's own order above already holds.
    if (withWaiters) {
        const held = new Set(ordered);
        for (const i of column.anchors) {
            if (!await sealable(bot, frame, column, i)) continue;
            for (const t of targetsOf(planRegistry.anchors()[i])) {
                if (t.v && cellState(bot, frame, t) !== 'ok' && !held.has(t)) add(t.v);
            }
        }
    }
    return need;
}

// trashOf — the trash blocks ONE trip to this cube is sent with (utils/trash), sized so the trip cannot run
// short whatever the cube asks of it: the climb to its stand, one helper, one block for every cell of the
// cube that does not already hold a block of the plan — the most a trash path can ever stand at once — and
// the walking reserve the pocket's planks row names, for the pillars and bridges of the walk there. It all
// comes back out, so it is carried by a body and never consumed by the building.
const TRASH_FOR_A_HELPER = 1;
const TRASH_FOR_THE_WALK = require('@thinking/architect_config').STOCK_THRESHOLDS
    .find(r => r.item === 'planks' && r.holder === 'bot').deficit_below;
function trashOf(bot, frame, anchor) {
    const empty = targetsOf(anchor).filter(t => !(t.v && cellState(bot, frame, t) === 'ok')).length;
    return fillerOf(anchor) + TRASH_FOR_A_HELPER + empty + TRASH_FOR_THE_WALK;
}

// stillOrdered — how much of one item the building's last whole reading still asks for, or null before any
// reading: an unread building is not a building that needs nothing (Law 25).
function stillOrdered(item) {
    return _buildNeed ? (_buildNeed[item] || 0) : null;
}

// buildNeed — the material of every cube of the plan that does not stand yet, each open stand column's own
// blocks counted once with its column's top cube. Read off the world on its own clock: the sum moves by one
// cube a trip.
const BUILD_NEED_EVERY_MS = 30000;
let _buildNeed = null;
let _buildNeedAt = 0;
async function buildNeed(bot, frame, finished) {
    if (_buildNeed && Date.now() - _buildNeedAt < BUILD_NEED_EVERY_MS) return _buildNeed;
    const anchors = planRegistry.anchors();
    const need = {};
    // A cell this body cannot see is not a cell that needs a block (the bill's own rule, readBalance): a walk
    // that meets one is no reading of the building. The last whole reading stands, and a body that has never
    // had one orders nothing.
    const unseen = (t) => cellState(bot, frame, t) === 'unseen';
    for (const c of planRegistry.columns()) {
        await pace();
        if (shaftTargets(c).some(unseen)) { _buildNeedAt = Date.now(); _buildNeed = _buildNeed || {}; return _buildNeed; }
        for (const i of c.anchors) {
            await pace();
            if (targetsOf(anchors[i]).some(unseen)) { _buildNeedAt = Date.now(); _buildNeed = _buildNeed || {}; return _buildNeed; }
        }
    }
    for (const column of planRegistry.columns()) {
        // A stand column with a cell still open is climbed again, and the climb clears it: all of it is owed.
        const shaftOpen = shaftTargets(column).some(t => cellState(bot, frame, t) !== 'ok');
        const top = column.anchors[column.anchors.length - 1];
        for (const index of column.anchors) {
            const withShaft = shaftOpen && index === top;
            if (finished.has(index) && !withShaft) continue;
            const anchor = anchors[index];
            const one = await cubeMaterials(bot, frame, column, anchor, withShaft, false);
            for (const [item, n] of Object.entries(one)) if (n > 0) need[item] = (need[item] || 0) + n;
        }
    }
    _buildNeed = need;
    _buildNeedAt = Date.now();
    return need;
}

// fillerOf — the blocks one trip climbs on to reach this cube's stand, one under the feet for every cell risen.
function fillerOf(anchor) {
    return anchor.layer * CUBE + 1 + ENTRY_FEET_BELOW;
}

// endsColumn — does this trip end the column? True for a seal-only trip, and for any cube whose column has every
// OTHER cube already standing as the plan asks — the same reading build_column_executor makes after the cube to
// decide the descent restores the stand column. A cube above it that is all air in the plan stands already, so
// the trip that ends a column is often not its top cube, and the descent's own blocks are owed on that trip.
async function endsColumn(bot, frame, column, next) {
    if (next.seal) return true;
    const anchors = planRegistry.anchors();
    for (const i of column.anchors) {
        await pace();
        if (i !== next.anchor.index && !allCorrect(bot, frame, targetsOf(anchors[i])) && !await sealable(bot, frame, column, i)) return false;
    }
    return true;
}

// ── DOES IRON EVER HOLD THE CASTLE UP? ──────────────────────────────────────────────────────────────
// The iron that matters is the iron a cube needs when its turn comes. Each sweep counts the cubes the window held
// back because their short includes iron, and whether ANY cube could be posted: posted=0 with iron_held>0 is the
// castle stopped on iron. Said when either changes (accounting_lens IRON_WAIT).
const IRON_RAW = /iron/;
let _ironWait = null;
function noteIronWait(posted, ironHeld) {
    const key = `${posted > 0}|${ironHeld.length}`;
    if (key === _ironWait) return;
    _ironWait = key;
    watcher.summary(TAG, `IRON_WAIT posted=${posted} iron_held=${ironHeld.length} stopped=${posted === 0 && ironHeld.length > 0} cubes=${ironHeld.slice(0, 6).join(',') || 'none'}`);
}

// The layer the building is on, said when it changes: `posted` cubes of the open layer are on the board, and
// `held` columns have their next cube on a layer that is not open.
let _openLayerSaid = null;
function noteOpenLayer(layer, posted, held) {
    if (layer === _openLayerSaid) return;
    _openLayerSaid = layer;
    watcher.summary(TAG, `OPEN_LAYER layer=${layer} posted=${posted} columns_held_on_other_layers=${held}`);
}

// What the open layer's cubes are short of when none could be posted: each material with the number of cubes
// it holds back. Said when it changes.
let _layerShortSaid = null;
function noteLayerShort(layer, posted, offered) {
    const by = {};
    if (posted === 0) for (const o of offered) for (const raw of (o.short || [])) by[raw] = (by[raw] || 0) + 1;
    const said = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([raw, n]) => `${raw}:${n}`).join(',') || 'none';
    const key = `${layer}|${posted > 0}|${said}`;
    if (key === _layerShortSaid) return;
    _layerShortSaid = key;
    watcher.summary(TAG, `OPEN_LAYER_SHORT layer=${layer} posted=${posted} cubes_short_of=${said}`);
}

async function assess() {
    const jobs = [];
    const bot = global.bot;
    const name = buildName();
    if (!name || !bot || !bot.blockAt || !bot.findBlocks) return { jobs };

    const row = sitedRow(name);
    // Not sited yet — the foreman locks the site before any body exists, so this is the window before a
    // handover has been recorded. Nothing to post and nothing to claim about it.
    if (!row) return { jobs };

    const plan = planRegistry.isLoaded() ? planRegistry.getPlan() : null;
    // The plan is loaded once by the builder's start step. Until it is, this assessor is silent rather
    // than loading it itself: a sweep is not the stopped state, and a snapshot taken from inside one
    // would be taken by whichever bot swept first (Law 26 — build while off, drive while on).
    if (!plan) return { jobs };

    const frame = planRegistry.siteFrame(row);
    const centre = row.transpose_origin;
    const structure = name;

    // PHASE 1 — trees. Posted as the fleet's one felling job, carrying this site's box.
    // THE LADDER HOLDS ON THE PHASE, NOT ON THE JOB. siteTreesJob returns nothing for three different
    // reasons and only one of them means the anchors may start: the phase is CLOSED. The other two —
    // every standing trunk already claimed by a peer, or a refused world scan — mean trees are still
    // coming down. Closing the latch is also what closes the box to navigation (downloaded_plan_registry
    // .closedBox), so it must not close while a feller still needs to walk the site.
    const box = planTreeBox(plan.dimensions);
    if (!siteTreePhaseDone(structure)) {
        const treesSeats = await siteTreesJob(structure, centre, box);
        jobs.push(...treesSeats);   // an ARRAY of seats — one per standing trunk, capped at the roster
        if (!siteTreePhaseDone(structure)) return { jobs, built: { [structure]: false } };
    }

    // PHASE 2 — the anchors, bottom-up, and the material order that makes the next one workable.
    //
    // NO CUBE BEFORE THE WOOD IS DECIDED. The building's one species is the site's (siteWood in the plan
    // registry says why), and until the fleet has counted the trees around the base there is no answer
    // for what a finished oak-or-birch stair looks like here. Building a first cube in the plan's wood
    // and the rest in the site's would mix two woods in one structure, which the material rule exists
    // to prevent.
    if (!frame.wood) {
        watcher.summary(TAG, `↳ "${structure}" anchors wait on the fleet's wood preference — the building is made of the wood that grows here`);
        return { jobs, built: { [structure]: false } };
    }

    const finished = rememberedFinished(structure);
    reverify(bot, frame, finished);
    const offered = [];
    const waiting = [];   // every open cube passed over this sweep, whether or not its column has a trip above it
    for (const column of planRegistry.columns()) {
        const next = await nextCube(bot, frame, column, finished);
        if (next) waiting.push(...next.passed);
        if (next && !next.waiting) offered.push({ column, ...next, order: next.anchor.layer * 1000 + column.column });
    }
    const waitingCubes = waiting.length;
    // BUILT MEANS EVERY CUBE AND EVERY STAND COLUMN STANDS AS THE PLAN ASKS.
    noteWaiting(waitingCubes);
    await noteFinished(bot, frame, finished);
    await readBalance(bot, frame, finished);
    if (!offered.length) {
        await noteWaitsOn(bot, frame, waiting, offered, finished);
        return { jobs, built: { [structure]: waitingCubes === 0 } };
    }
    offered.sort((a, b) => a.order - b.order);

    // ── LOWEST LAYER FIRST ──────────────────────────────────────────────────────────────────────────
    // The open layer is the lowest one holding a cube a trip can still move a block of, and its cubes are
    // posted first. The layer above is posted once every posted cube below it is held by a body, so a layer
    // down to its last cubes does not leave the rest of the crew without a build job.
    const openLayer = offered[0].anchor.layer;

    // THE ORDER IS THE WHOLE BUILDING: the material of every cube that does not stand yet, whatever its layer.
    // The crew gathers for all of it while the open layer is built; the board's fill levels spread the bodies
    // across the kinds. Cubes are posted in build order, the first PRICED_PER_SWEEP the pool covers.
    // TRASH IS PRICED WITH THE CUBE (trashOf, utils/trash): a cube is paid when the pool covers its blocks and
    // its trip's trash together, so a body is never posted to a cube it cannot be stocked for. The trash order
    // is what the bodies building at once carry, never a sum over every cube: each trip takes its trash back out.
    const windowNeed = { ...await buildNeed(bot, frame, finished) };
    // Holdings are sensed after the long world scan, immediately before pricing the offers (Invariant B).
    const pool = inventoryLens.buildPool(structure);
    const ironHeld = [];   // cubes of the open layer held back by a short that includes iron
    let maxTrash = 0;
    let postedCubes = 0;
    let paidNeed = {};
    let paidTrash = 0;
    // This body's own chair is left out: a cube it held and could not stage is priced like any other.
    const selfId = process.env.BOT_ID || 'default';
    const heldByPeer = new Set(Object.entries(hq.getFullBoardroom({}))
        .filter(([botId]) => botId !== selfId).map(([, chair]) => chair?.magnet?.job_id).filter(Boolean));
    // THE NEXT LAYER OPENS WHEN THE ONE BELOW HAS NO BUILD JOB LEFT TO TAKE: `unclaimed` counts the cubes posted
    // on the layer being priced that no peer holds, and a higher layer is priced only while that count is zero.
    let pricedLayer = openLayer;
    let unclaimed = 0;
    for (const o of offered) {
        if (o.anchor.layer !== pricedLayer) {
            if (unclaimed > 0) { o.layerClosed = true; continue; }
            pricedLayer = o.anchor.layer;
        }
        const need = await cubeMaterials(bot, frame, o.column, o.anchor, await endsColumn(bot, frame, o.column, o));
        const cubeTrash = trashOf(bot, frame, o.anchor);
        maxTrash = Math.max(maxTrash, cubeTrash);
        if (postedCubes >= PRICED_PER_SWEEP) continue;
        // SPECIES-TRUE: only the site's own logs and planks count toward this building (see
        // remainingRawInSpecies), so the order names `<wood>_log` and the gate and the prep agree on it.
        // ONE POOL PAYS FOR THE CUBES TOGETHER: a cube is paid when the pool covers it on top of every cube paid
        // before it this sweep. A cube a peer holds took its material out of the pool with that body, so it
        // is posted without being counted again.
        if (!heldByPeer.has(`site_column_${structure}_${o.column.column}`)) {
            const together = { ...paidNeed };
            for (const [item, n] of Object.entries(need)) together[item] = (together[item] || 0) + n;
            const short = Object.keys(trash.shortWith(together, paidTrash + cubeTrash, pool, frame.wood));
            if (short.length) {
                if (short.some(raw => IRON_RAW.test(raw))) ironHeld.push(o.anchor.index);
                o.short = short;
                continue;
            }
            paidNeed = together;
            paidTrash += cubeTrash;
        }
        o.posted = true;
        postedCubes++;
        // A CUBE A PEER HOLDS IS THAT PEER'S: it counts as posted for the layer and the waits, it was not priced
        // against this body's pool, and it is no job on this body's board.
        if (heldByPeer.has(`site_column_${structure}_${o.column.column}`)) continue;
        unclaimed++;
        jobs.push({
            id: `site_column_${structure}_${o.column.column}`, type: 'column', what: 'build_column',
            where: entryFoot(frame, o.column), structure,
            column: o.column.column, anchor_index: o.anchor.index, build_order: o.order,
            job_type: JOB_TYPE.site_column, scope: 'shared', claimed_by: null,
        });
    }

    noteOpenLayer(openLayer, postedCubes, offered.filter(o => o.layerClosed).length);
    noteLayerShort(openLayer, postedCubes, offered);
    noteIronWait(postedCubes, ironHeld);
    await noteWaitsOn(bot, frame, waiting, offered, finished);
    // The order is delivered to the chests, so it is measured on what the building can be handed: the chests,
    // a furnace's batch, and what a body carries past its own pocket's keep. What a pocket keeps for its body
    // (its planks) is not the building's.
    const deliverable = inventoryLens.deliverableHoldings();
    // THE TRASH ORDER IS WOOD: what the bodies building at once carry — one trip's worth for each cube on offer,
    // never more trips than the crew has bodies — less what spare wood already held pays, asked for as planks
    // of the building's wood so the wood order grows by the logs that make them.
    const tripsAtOnce = Math.min(offered.filter(o => !o.layerClosed).length, PRICED_PER_SWEEP, Object.keys(hq.getFullBoardroom({})).length);
    const trashPlanks = trash.fromBuildWood(maxTrash * tripsAtOnce, deliverable, frame.wood);
    if (trashPlanks > 0) windowNeed[`${frame.wood}_planks`] = (windowNeed[`${frame.wood}_planks`] || 0) + trashPlanks;
    const windowShort = remainingRawInSpecies(windowNeed, deliverable, frame.wood);

    const pullNeeded = {};
    const surfaceNeeded = {};
    if (Object.keys(windowShort).length) {
        for (const [raw, count] of Object.entries(windowShort)) {
            if (isUnderground(raw)) pullNeeded[raw] = count;
            else surfaceNeeded[raw] = count;
        }
        const poolChest = homeChest();
        const posted = [];
        const { absentNearby } = require('@action/harvest_executor');
        for (const [raw, gap] of Object.entries(surfaceNeeded)) {
            if (gap <= 0) continue;
            // A gather the whole loaded world just came back empty for is not offered again until its note expires.
            if (absentNearby(raw)) continue;
            // Into the base chest when one stands, into the pocket before it does — the same two
            // routes `assessors/building` takes, and the same reason: a build cannot gate on a chest
            // it has not built yet. `deliverScope` decides the scope dynamically, so a craftable
            // material moves to a shared lock on its own; a hardcoded scope would silently authorise
            // duplicate crafts.
            jobs.push(poolChest
                ? supplyJob({
                    id: `site_chest_${raw}`, what: raw, need: gap, net_of_pool: true, where: poolChest.station.pos,
                    station_id: poolChest.id, destination: require('@kernel/bot_mandate').homeBlueprint(), structure,
                    job_type: JOB_TYPE.site_supply, claimed_by: null,
                    hold_goal: gap, at_destination: 0,
                    // One asker: the site being built. Delivered to a chest, so no pocket term.
                    parts: [{ who: `blueprint:${structure}`, amount: gap }],
                    category: 'resource', action: 'deliver', scope: deliverScope(raw),
                    level: levelOf(raw, gap, pool), ...levelShelf(raw, gap, pool),
                })
                : supplyJob({
                    id: `site_supply_${raw}`, what: raw, need: gap, net_of_pool: true, where: null, structure,
                    job_type: JOB_TYPE.site_supply, claimed_by: null,
                    hold_goal: countInInventory(raw, getBotInventory()) + gap,
                    at_destination: countInInventory(raw, getBotInventory()),
                    // The pocket-destination twin of the branch above, and the same cross-category sum
                    // `assessors/building` carries — body's current holding plus the site's remaining
                    // gap. Both terms named so the total can be read back apart.
                    parts: [
                        { who: `bot:pocket_carried_${raw}`, amount: countInInventory(raw, getBotInventory()) },
                        { who: `blueprint:${structure}`, amount: gap },
                    ],
                    category: 'resource', scope: 'local',
                    level: levelOf(raw, gap, pool), ...levelShelf(raw, gap, pool),
                }));
            posted.push(`${raw}:${gap}`);
        }
        // LEAVES ARE ONLY EVER CUT, AND ONLY SHEARS CUT THEM WHOLE. A bare hand or any other tool breaks a
        // leaf block into a sapling or nothing, so a leaf order in a shearless pocket is a gather that
        // comes back empty every time. job_gates.toolGate holds the leaf order from a bot without shears;
        // this is the other half — the pair of shears that releases it, made from two of the iron the
        // castle already draws on. ONE PAIR FOR THE WHOLE FLEET: posted only while a leaf order stands and no
        // body or chest holds a pair, as one shared seat, so one body makes it and that body cuts the leaves.
        const leafOrdered = Object.keys(surfaceNeeded).some(raw => raw.endsWith('_leaves') && surfaceNeeded[raw] > 0);
        if (leafOrdered && inventoryLens.reachableByFleet('shears') === 0) {
            jobs.push(supplyJob({
                id: 'site_supply_shears', what: 'shears', need: 1, where: null, structure,
                job_type: JOB_TYPE.site_supply, claimed_by: null,
                hold_goal: 1, at_destination: 0,
                // One asker, one pair: the site's leaf order is what makes shears necessary.
                parts: [{ who: `blueprint:${structure}_leaf_tool`, amount: 1 }],
                category: 'crafting', scope: 'shared',
            }));
            posted.push('shears:1');
        }
        if (posted.length) watcher.summary(TAG, `↳ "${structure}" window of ${offered.length} column(s), layers ${offered[0].anchor.layer}..${offered[offered.length - 1].anchor.layer}, ${postedCubes} cube(s) paid — order: ${posted.join(', ')}`);
    }

    // The claim and the pull are declared so the layers above can subtract them: storage may not
    // count material this cube has already spoken for, and the mine is told what the build is
    // waiting on. Both are the SHORTFALL, not the requirement — what is already held is in the
    // pool and would be subtracted twice.
    return {
        jobs, pullNeeded, pullAsker: { job_type: JOB_TYPE.site_supply, structure },
        buildClaim: { ...pullNeeded, ...surfaceNeeded },
        built: { [structure]: false },
    };
}

// cubeMaterials, targetsOf, shaftTargets and endsColumn are exported for column_preparation and the executor,
// which must ask the SAME questions this gate asked before it posted the cube (Law 16) — two copies of "what
// does this cube own" or "what does this trip need" could disagree.
module.exports = { name: 'downloaded_build', assess, buildName, sitedRow, castleBalance, finishedCount,familyLevel,cubeMaterials, trashOf, stillOrdered, targetsOf, shaftTargets, endsColumn, entryFoot, entryMouth, waitsOnSupport, sealable, forgetFinished };
