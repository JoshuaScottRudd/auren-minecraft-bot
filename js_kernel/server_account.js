// module: server_account
// purpose: EVERY TIME THE SERVER PUTS THIS BODY SOMEWHERE, THE BODY SAYS SO. The server owns the body's
//          position and may set it at any moment; mineflayer reports each one as `forcedMove`. Each is one
//          line: where the body believed it stood, where the server put it, how far that is, and the blocks
//          this body sees at the cell it was put in — the two readings a disagreement between this body's
//          world and the server's shows up in.
//
// The first one of a life is the server placing the body at login (`kind=login`). A move the fleet asked
// the server for — a placement or a recovery teleport, announced here by `expect` before the command is
// sent — is `kind=ordered`. Every other one is the server overruling a move the body made
// (`kind=set_back`), and is a warning.

'use strict';

const TAG = 'server_account';
const fix = n => n.toFixed(2);

// The one move the fleet has asked the server for and not yet seen: { at, until }. `at` is the cell asked
// for, or null when the command names a player to stand beside and the cell is the server's to choose.
const ORDER_REACH = 2;      // blocks between the cell asked for and the cell the server put the body in
let order = null;

// expect(at, withinMs) — called by the one module that sends a teleport, before it sends it.
function expect(at, withinMs) {
    order = { at: at || null, until: Date.now() + withinMs };
}

// Takes the order if this move answers it: inside its time, and at the cell asked for where one was named.
function takeOrder(p) {
    if (!order || Date.now() > order.until) { order = null; return false; }
    const at = order.at;
    if (at && Math.hypot(p.x - (at.x + 0.5), p.y - at.y, p.z - (at.z + 0.5)) > ORDER_REACH) return false;
    order = null;
    return true;
}

function arm(bot) {
    const watcher = require('@kernel/watcher');
    let believed = null;     // the body's own position on its last physics tick
    let moves = 0;

    bot.on('physicsTick', () => {
        const p = bot.entity && bot.entity.position;
        if (p) believed = { x: p.x, y: p.y, z: p.z };
    });

    bot.on('forcedMove', () => {
        const p = bot.entity && bot.entity.position;
        if (!p) return;
        moves++;
        const from = believed;
        const moved = from ? Math.sqrt((p.x - from.x) ** 2 + (p.y - from.y) ** 2 + (p.z - from.z) ** 2) : null;
        const cell = p.floored();
        const nameAt = dy => {
            const b = typeof bot.blockAt === 'function' ? bot.blockAt(cell.offset(0, dy, 0)) : null;
            return b ? b.name : 'unseen';
        };
        // The four cells beside the body, each with the shape this body believes it has: a set-back against a
        // cell this body holds to be open is the two worlds disagreeing about that cell.
        const sides = dy => [['w', -1, 0], ['e', 1, 0], ['n', 0, -1], ['s', 0, 1]].map(([k, dx, dz]) => {
            const b = typeof bot.blockAt === 'function' ? bot.blockAt(cell.offset(dx, dy, dz)) : null;
            return `${k}:${b ? `${b.name}/${b.boundingBox}` : 'unseen'}`;
        }).join(',');
        const kind = moves === 1 ? 'login' : takeOrder(p) ? 'ordered' : 'set_back';
        const line = `SERVER_MOVED n=${moves} kind=${kind} `
            + `from=${from ? `(${fix(from.x)},${fix(from.y)},${fix(from.z)})` : 'unknown'} to=(${fix(p.x)},${fix(p.y)},${fix(p.z)}) `
            + `moved=${moved === null ? 'unknown' : fix(moved)} below=${nameAt(-1)} feet=${nameAt(0)} head=${nameAt(1)}`
            + ` sides_at_feet=${sides(0)} sides_at_head=${sides(1)}`;
        if (kind === 'set_back') watcher.warn(TAG, line);
        else watcher.summary(TAG, line);
        believed = { x: p.x, y: p.y, z: p.z };
    });
}

module.exports = { arm, expect, TAG };
