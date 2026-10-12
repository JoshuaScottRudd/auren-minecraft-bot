// module: block_face_seat
// purpose: A BODY PRESSED AGAINST A BLOCK FACE STANDS OUTSIDE THE BLOCK, BY ARITHMETIC AS WELL AS BY INTENT.
//          The physics library stops a body at a wall by setting its centre to the face plus the body's half
//          width (0.3). In floating point that sum does not always come back apart: at x = 32 the body's edge
//          computes as 31.999999999999996, a hair inside the block. The library's collision test asks whether
//          the edge is at or beyond the face, reads "inside", and stops no further move into that block — the
//          body walks into a wall it knows is solid, and the server refuses each step and sets it back.
//
// After every physics tick, an edge that lies inside a block boundary by less than SLIVER is moved onto the
// open side of it by NUDGE. The move is a ten-millionth of a block, away from the wall.

'use strict';

const HALF_WIDTH = 0.3;
const SLIVER = 1e-9;     // an edge this far past a block boundary is the rounding, never a position
const NUDGE = 1e-7;

// seated — the centre coordinate with neither edge a sliver inside a block boundary.
function seated(c) {
    const low = c - HALF_WIDTH;
    const lowFace = Math.ceil(low);
    if (lowFace - low > 0 && lowFace - low < SLIVER) return lowFace + HALF_WIDTH + NUDGE;
    const high = c + HALF_WIDTH;
    const highFace = Math.floor(high);
    if (high - highFace > 0 && high - highFace < SLIVER) return highFace - HALF_WIDTH - NUDGE;
    return c;
}

function arm(bot) {
    bot.on('physicsTick', () => {
        const p = bot.entity && bot.entity.position;
        if (!p) return;
        const x = seated(p.x);
        const z = seated(p.z);
        if (x !== p.x) p.x = x;
        if (z !== p.z) p.z = z;
    });
}

module.exports = { arm, seated };
