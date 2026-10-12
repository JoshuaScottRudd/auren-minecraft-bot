// module: item_book
// purpose: THIS BODY'S CLERK FOR THE FLEET'S ONE ITEM BOOK (foreman/item_book.js). Every change to this
//          pocket is read off the pocket itself — the server's own slot contents — and sent to the foreman
//          as a move with a cause. The foreman holds the book; this module holds no totals.
//
// ── THE POCKET IS THE COUNT, THE CALLER IS THE CAUSE ─────────────────────────────────────────────────
//   A move is the difference between two readings of the pocket. An authority that changes the pocket
//   (place, toss, chest window, craft, furnace, eat, sow) names the cause around its own act with
//   during() or settle()+mark(); the count is never the caller's — it is what the pocket did.
//   A change no authority named is sent as 'unattributed', so a path this book does not cover shows up
//   in the book as a number.
//
// ── PICKUPS ARE THE SERVER'S WORD ────────────────────────────────────────────────────────────────────
//   The `collect` packet names the collector, the collected entity and the count. Each of this body's
//   pickups is sent with the entity's id and the cell it first appeared in, and the foreman decides
//   where that drop came from (the world, a thrown stack, a block the fleet placed, a dead body).
//   The packet lands a tick ahead of the slot it fills, so a reading waits PICKUP_SETTLE_MS on a fresh
//   pickup before it is taken.

'use strict';

const TAG = 'item_book';
const SEND_MS = 2000;            // queue → foreman
const AUDIT_MS = 30000;          // the whole pocket, sent so the foreman can check its own figure
const STICKY_MS = 2000;          // a slot update this late after a named act still belongs to it
const BUSY_MS = 15000;           // an act that never returns (a combat abandon) frees the idle reading
const PICKUP_SETTLE_MS = 80;     // the collect packet leads its slot update by up to one server tick
const BASELINE_AFTER_SPAWN_MS = 3000;
const POCKET_FROM = 5, POCKET_TO = 45;   // armour, main inventory, hotbar, off hand
const QUEUE_CAP = 20000;

let _bot = null;
let _last = null;                // the pocket at the last reading; null until the baseline is taken
let _picked = {};                // pickups heard since the last reading
let _pickedAt = 0;
let _queue = [];
let _lastAct = null;             // { cause, party, at } of the last named act
let _busyUntil = 0;
let _dead = false;
let _sendTimer = null, _auditTimer = null;
let _ratioSaid = null;
const _spawnCell = new Map();    // item entity id → the cell it first appeared in

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cellOf = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];

function tally(bot) {
    const t = {};
    const slots = bot.inventory.slots;
    for (let i = POCKET_FROM; i <= POCKET_TO; i++) {
        const it = slots[i];
        if (it) t[it.name] = (t[it.name] || 0) + it.count;
    }
    return t;
}

function report(entry) {
    if (_queue.length >= QUEUE_CAP) _queue.shift();
    _queue.push(entry);
}

function flush() {
    if (!_queue.length) return;
    if (require('@kernel/foreman_link').sendItemBook(_queue)) _queue = [];
}

// One reading of the pocket. Whatever changed since the last one, less the pickups already sent, goes
// to `cause` with `party` as the other side of the move.
function _read(cause, party, extra) {
    if (!_bot || _dead || _last === null) return;
    const now = tally(_bot);
    for (const item of new Set([...Object.keys(now), ...Object.keys(_last), ...Object.keys(_picked)])) {
        const d = (now[item] || 0) - (_last[item] || 0) - (_picked[item] || 0);
        if (!d) continue;
        report({ k: 'm', i: item, n: Math.abs(d), f: d < 0 ? 'pocket' : party, t: d < 0 ? party : 'pocket', c: cause, ...(extra || {}) });
    }
    _last = now;
    _picked = {};
}

// settle() — reads the pocket ahead of a named act, so the act's own reading holds only the act.
function settle() {
    const sticky = _lastAct && _lastAct.sticky && Date.now() - _lastAct.at < STICKY_MS;
    _read(sticky ? _lastAct.cause : 'unattributed', sticky ? _lastAct.party : 'unattributed');
}

// mark(cause, party, extra) — reads the pocket after an act. `sticky` false is for an act whose pocket
// change is immediate (a tool breaking in a dig), so a later unnamed change is never laid on it.
function mark(cause, party, extra, sticky = true) {
    _read(cause, party, extra);
    _lastAct = { cause, party, at: Date.now(), sticky };
    _busyUntil = 0;
}

async function _pickupSettled() {
    const owed = PICKUP_SETTLE_MS - (Date.now() - _pickedAt);
    if (owed > 0) await sleep(owed);
}

async function open() {
    _busyUntil = Date.now() + BUSY_MS;
    await _pickupSettled();
    settle();
}

async function close(cause, party, extra, sticky) {
    await _pickupSettled();
    mark(cause, party, extra, sticky);
}

// during(cause, party, fn, extra) — runs fn as one named act. `extra` may be a function of fn's result.
async function during(cause, party, fn, extra) {
    await open();
    const r = await fn();
    await close(cause, party, typeof extra === 'function' ? extra(r) : extra);
    return r;
}

function _audit() {
    if (!_bot || _dead || _last === null || _bot.currentWindow) return;
    if (Date.now() < _busyUntil || Date.now() - _pickedAt < PICKUP_SETTLE_MS) return;
    settle();
    report({ k: 'au', items: _last });
    const plans = require('@kernel/downloaded_plan_registry');
    if (plans.isLoaded()) {
        const r = plans.materialRatio();
        const said = `ratio target iron_ingots=${r.iron_ingots} cobblestone=${r.cobblestone} cobblestone_per_iron=${r.cobblestone_per_iron}`;
        if (said !== _ratioSaid) { _ratioSaid = said; require('@kernel/watcher').summary(TAG, said); }
    }
}

// spawnCellOf(id) — the cell an item entity first appeared in, while this body still has it in view.
function spawnCellOf(id) { return _spawnCell.get(id) || null; }

// arm(bot) — called once, right after createBot, beside the other login-time listeners.
function arm(bot) {
    if (!bot || !bot._client) throw new Error(`[${TAG}] CODING VIOLATION: arm called with no client to listen on.`);
    if (_bot) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): arm() called twice — every move would be sent twice.`);
    _bot = bot;

    bot.on('entitySpawn', (e) => { if (e && e.name === 'item' && e.position) _spawnCell.set(e.id, { cell: cellOf(e.position), at: Date.now() }); });
    bot.on('entityGone', (e) => { if (e) setTimeout(() => _spawnCell.delete(e.id), 1000).unref(); });

    bot._client.on('collect', (packet) => {
        if (!bot.entity || packet.collectorEntityId !== bot.entity.id) return;
        const entity = bot.entities[packet.collectedEntityId];
        const item = entity && typeof entity.getDroppedItem === 'function' ? entity.getDroppedItem() : null;
        if (!item || !item.name) return;          // an experience orb or an arrow — not an item
        const n = Number.isInteger(packet.pickupItemCount) && packet.pickupItemCount > 0 ? packet.pickupItemCount : item.count;
        if (_last !== null && !_dead) { _picked[item.name] = (_picked[item.name] || 0) + n; _pickedAt = Date.now(); }
        const born = _spawnCell.get(entity.id);
        report({ k: 'p', e: entity.id, i: item.name, n, s: born ? born.cell : null, a: cellOf(entity.position) });
    });

    // The pocket a body arrives with enters the book once the login's inventory packet has landed.
    bot.on('spawn', () => {
        setTimeout(() => {
            if (_last === null) {
                _last = tally(bot);
                for (const [i, n] of Object.entries(_last)) report({ k: 'm', i, n, f: 'start', t: 'pocket', c: 'start' });
            } else if (_dead) {
                _last = {};
                _dead = false;
            }
        }, BASELINE_AFTER_SPAWN_MS).unref();
    });

    // A dead body's pocket is on the ground where it died; the client's own slots stay as they were
    // until a respawn, so the book is told here and no reading is taken while dead.
    bot.on('death', () => {
        if (_last === null || _dead) return;
        settle();
        const at = bot.entity && bot.entity.position ? cellOf(bot.entity.position) : null;
        report({ k: 'de', at, items: _last });
        _last = {};
        _dead = true;
    });

    _sendTimer = require('@utils/timeout_crash').every('item_book', 'send queued item readings to the foreman', flush, SEND_MS);
    _sendTimer.unref();
    _auditTimer = require('@utils/timeout_crash').every('item_book', 'check the pocket against the book', _audit, AUDIT_MS);
    _auditTimer.unref();
}

// end — the body is ending; the last reading and the queue go to the foreman while the socket is open.
function end() {
    if (_sendTimer) { require('@utils/timeout_crash').stop(_sendTimer); _sendTimer = null; }
    if (_auditTimer) { require('@utils/timeout_crash').stop(_auditTimer); _auditTimer = null; }
    if (_bot && !_dead && _last !== null) { settle(); report({ k: 'au', items: _last }); }
    flush();
}

module.exports = { arm, end, settle, mark, open, close, during, report, flush, spawnCellOf, TAG };
