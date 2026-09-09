'use strict';
// body_recovery — the two acts of putting a dead body back on its feet, owned in ONE place.
//
// ── WHY THIS FILE EXISTS (Architect's ruling: identical logic in every place a body is stood up) ──────
// A bot's body is stood up in four situations and they used to be served by two implementations:
//   · NATURAL DEATH   — a live bot died mid-run.                          (death_manager)
//   · STARTING        — a continue inherits a world whose last run ended on a corpse. (fleet_revive)
//   · SPAWNING        — a bot is launched onto playerdata that reads dead.
//   · GETTING         — a human says `foreman get` and the slot they are handed holds a corpse.
// The last two had NO implementation at all, which is how a person in the world could be handed a bot
// that never stands up and that no operator verb can reach.
//
// The two that existed agreed on the discipline and disagreed on the details, which is the Law 16 shape
// exactly: same capability, two routes, and the differences are invisible until one of them is wrong.
// One clicked respawn immediately; the other knew it must not. Both wrote the same teleport-and-verify
// loop. Both derived the same recovery cell from the same blueprint. Four copies of two acts.
//
// ── WHAT IS SHARED AND WHAT IS NOT ───────────────────────────────────────────────────────────────────
// SHARED (here): the two ACTS and their verification — click respawn and sense whether a body came back;
// teleport and sense whether it actually moved. Neither act trusts its own command. A respawn packet
// accepted is not a body; an RCON `tp` that returned cleanly is not an arrival (Law 25: the verdict is
// measured against the world, never against "I sent the command").
//
// NOT SHARED, and deliberately so:
//   · WHERE the body goes. That is a policy with two ladders — a contractor's own sited house versus a
//     homesteader's estate — and it belongs with the seat that owns the policy, not with the mechanism.
//   · WHO OWNS THE CLIENT. The in-process caller already has a live bot. The out-of-process caller must
//     BUILD one, because a corpse never receives `spawn`, so master_core never initialises, so the
//     fragment that would fix the corpse is inside the process the corpse prevents from starting. That
//     asymmetry is structural and no amount of sharing removes it — which is why this file takes a bot
//     HANDLE and never creates one.
//
// ── THE ONE FACT THAT MUST NOT BE LOST AGAIN ─────────────────────────────────────────────────────────
// `bot.respawn()` opens with `if (bot.isAlive) return`, and mineflayer initialises `isAlive` to TRUE at
// plugin inject — it only flips false when the first `update_health` packet arrives carrying zero. A
// click sent before that packet lands inside the window, returns silently having written NO packet, and
// the wait that follows times out looking exactly like a server that refused a respawn. This cost a full
// run to find, it is a property of the library rather than of any one caller, and it was known to one of
// the two implementations and not the other. Gating every click on a known health reading is the whole
// reason a shared file is worth more than a shared convention.

const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'body_recovery';

// ── THE WINDOWS ──────────────────────────────────────────────────────────────────────────────────────
// ONE SET OF NUMBERS FOR EVERY CALLER, not a parameter each. A knob here would immediately become the
// difference between the callers again, in the file written to end that. The values are the generous
// ones, because generosity only costs time in the FAILURE case: a live client that respawns instantly
// leaves the poll on its first pass, so a wider cap changes nothing about a success and buys the
// fresh-login case the seconds it genuinely needs.
const HEALTH_WAIT_MS = 10000;   // for the first update_health packet — see the isAlive window above
const RESPAWN_WAIT_MS = 15000;  // from the click to a body being back
const TELEPORT_WAIT_MS = 4000;  // longer than a respawn: a tp crosses a chunk boundary the client is
                                // then told about, so the position mineflayer reports lags the server's
const VERIFY_POLL_MS = 100;

// How close counts as arrived. A `tp` to integer coordinates lands the body at cell centre (+0.5), and a
// body standing on a block reports fractional drift while it settles — so a tolerance is required or the
// verify would report failure on a teleport that worked. Kept tight enough that landing on the WRONG
// block still fails.
const ARRIVAL_TOLERANCE = 2.0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// isDead(bot) — the ONE predicate. Imported by job_board's planner as well as by the acts below, so the
// planner and the thing it dispatches can never disagree about whether there is a body (Law 16).
// `bot.isAlive` is mineflayer's own flag off the health packet and is the honest primary; the other two
// catch the window around a respawn where the flag is set but the body is not back.
function isDead(bot) {
  if (!bot) return true;
  if (bot.isAlive === false) return true;
  if (!bot.entity || !bot.entity.position) return true;
  return typeof bot.health === 'number' && bot.health <= 0;
}

// awaitKnownHealth(bot) → number | null — the server's own answer about this body, or null on silence.
//
// SEPARATE FROM THE CLICK because it is a different question with a different failure. Not knowing
// whether a body is dead is not the same as failing to revive it, and collapsing the two reports a
// refused respawn for a server that simply never spoke (Law 25). Returns immediately when a reading is
// already in hand, which is every in-process caller — the wait exists for a client that just logged in.
function awaitKnownHealth(bot, timeoutMs = HEALTH_WAIT_MS) {
  return new Promise((resolve) => {
    if (typeof bot.health === 'number') return resolve(bot.health);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    bot.once('health', () => done(typeof bot.health === 'number' ? bot.health : null));
  });
}

// ── ACT 1 ────────────────────────────────────────────────────────────────────────────────────────────
// reviveBody(bot) → { revived, wasDead, why, healthUnknown }
//
// master_core and the out-of-process client BOTH run with `respawn: false`, so nothing else in the fleet
// sends this packet. That gating is what makes a death a hard stop: a corpse cannot walk, mine or place,
// so the chain that was running when the bot died is inert by physics rather than by a check arriving in
// time (Law 13, default-stopped). It also means a click that does not take strands the body permanently,
// which is why the outcome is sensed rather than assumed.
async function reviveBody(bot) {
  const health = await awaitKnownHealth(bot);
  if (health === null) {
    return {
      revived: false,
      wasDead: null,
      healthUnknown: true,
      why: `the server sent no health packet within ${HEALTH_WAIT_MS}ms — this body's state is unknown, so nothing was clicked`,
    };
  }
  if (!isDead(bot)) return { revived: false, wasDead: false, healthUnknown: false, why: 'the body is already standing' };

  if (typeof bot.respawn === 'function') guardExternalSync(TAG, 'respawn click', () => bot.respawn());

  for (const end = Date.now() + RESPAWN_WAIT_MS; Date.now() < end;) {
    if (!isDead(bot)) return { revived: true, wasDead: true, healthUnknown: false, why: 'clicked respawn and a body came back' };
    await sleep(VERIFY_POLL_MS);
  }
  return {
    revived: false,
    wasDead: true,
    healthUnknown: false,
    why: `clicked respawn and no body came back within ${RESPAWN_WAIT_MS}ms — with respawn:false nothing else sends it`,
  };
}

// ── ACT 2 ────────────────────────────────────────────────────────────────────────────────────────────
// teleportTo(bot, at, { name }) → { moved, from, to, error }
//
// NOT a mineflayer client command — a plain client has no console. The fleet has RCON, `js_kernel/utils/rcon_link`
// is the one shared implementation, and any process on this box can open a session. So the bot cannot
// teleport ITSELF as a client, and the fleet can teleport it as an operator.
//
// NO WALK FALLBACK, on purpose. An earlier draft walked home when the teleport was unavailable, and that
// is precisely the fallback Law 16 forbids: a second route that silently does the primary's job, reached
// exactly when nobody is watching. A teleport that cannot happen is reported as a failure and the caller
// decides.
async function teleportTo(bot, at, { name = null } = {}) {
  const who = name || (bot && bot.username) || process.env.BOT_ID;
  // A NAME IS NOT DEFAULTED. `tp` addressed to a guessed username moves somebody else's body, and the
  // command succeeds while doing it — a failure nothing downstream could catch (Law 13).
  if (!who) throw new Error(`[${TAG}] CODING VIOLATION: teleportTo has no username — the bot handle carries none and no name was passed.`);

  const from = bot && bot.entity && bot.entity.position ? bot.entity.position.floored() : null;
  // A COORDINATE CHECK BEFORE THE COMMAND, because without it two different failures are
  // indistinguishable downstream and the wrong one gets read (Law 25): a `tp` the server REFUSED and a
  // `tp` the client was slow to acknowledge both end at the arrival timeout below, whose wording
  // describes only the second. Thrown rather than soft-failed — a non-finite cell reaching here is a
  // caller that skipped its own validation, which cannot happen in a correct system (Law 13).
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) {
    throw new Error(`[${TAG}] CODING VIOLATION: teleportTo was handed a cell that is not a position: ${JSON.stringify(at)}. The caller must validate before it returns one.`);
  }

  // A REAL BOUNDARY. rcon_link opens a socket to the server and the throw originates in the rcon package
  // behind it, so a refused connection or a dropped session is the network's and not ours.
  const sent = await guardExternal(TAG, `rcon tp ${who}`,
    () => require('./utils/rcon_link').once([`tp ${who} ${at.x} ${at.y} ${at.z}`]));
  if (!sent.ok) return { moved: false, from, to: at, error: `rcon: ${sent.reason}` };

  for (const end = Date.now() + TELEPORT_WAIT_MS; Date.now() < end;) {
    const p = bot && bot.entity && bot.entity.position;
    if (p && Math.hypot(p.x - (at.x + 0.5), p.y - at.y, p.z - (at.z + 0.5)) <= ARRIVAL_TOLERANCE) {
      return { moved: true, from, to: at, error: null };
    }
    await sleep(VERIFY_POLL_MS);
  }
  const now = bot && bot.entity && bot.entity.position ? bot.entity.position.floored() : null;
  return { moved: false, from, to: at, error: `no arrival within ${TELEPORT_WAIT_MS}ms — body reads ${now ? `(${now.x},${now.y},${now.z})` : 'nowhere'}` };
}

// ── ACT 2b ───────────────────────────────────────────────────────────────────────────────────────────
// teleportToPlayer(botName, playerName) → { sent, error }
//
// THE ASK (Architect 2026-09-05, first time he used the desk as a player): *"i joined the server and said
// foreman get and i only got one bot. it didnt teleport the bot to my location."* A crew spawns where the
// server spawns it, which is not where the person who hired it is standing — so a contractor that arrived
// perfectly was, from the only viewpoint that matters, absent.
//
// WHY IT SITS BESIDE `teleportTo` RATHER THAN INSIDE IT (Law 16 — one teleport, and this is that one, in
// its second address form). `teleportTo` moves a body to a CELL and its caller holds a mineflayer handle
// to verify with. This moves a body to a PERSON, and the two differ in more than the argument:
//   · `tp <bot> <player>` is resolved by the SERVER, so it needs neither the player's coordinates nor the
//     player's chunk to be loaded anywhere. Reading a position first and passing it as a cell would fail
//     silently for any player standing outside the caller's view distance — which, on an open-chat desk
//     that hears the whole map, is most of them.
//   · The caller here is the FOREMAN, which holds no handle on the body it is moving: contractors are
//     separate OS processes and the desk knows them only through the overseer's registry.
//
// ── IT REPORTS `sent`, NOT `moved`, AND THAT WORD IS THE WHOLE DISCLOSURE ────────────────────────────
// `teleportTo`'s header says the fleet's two recovery acts share one property: *"neither act trusts its
// own command."* This one CANNOT hold that property, because verification needs a handle on the body and
// the only process with one is the bot itself. So it does not pretend to: the return field is named for
// what was actually established — that the server accepted the command — and a caller that wants arrival
// must observe it some other way. Naming it `moved` would be the invented verdict Law 25 forbids, and it
// would be invisible: a tp that the server accepted and that did nothing looks identical from here.
//
// **If arrival ever has to be guaranteed, this moves into the contractor's own spawn path**, where the
// body has a handle on itself and can verify the way `teleportTo` does. That is the better design and it
// was not taken today only because it edits the spawn path of every bot in the fleet, which is a larger
// blast radius than the fault justifies.
async function teleportToPlayer(botName, playerName) {
  // NEITHER NAME IS DEFAULTED, for `teleportTo`'s reason doubled: a guessed bot name moves somebody
  // else's body, and a guessed player name moves a body to a stranger. Both commands succeed while doing
  // it (Law 13 — a wrong answer that still runs).
  if (!botName || !playerName) {
    throw new Error(`[${TAG}] CODING VIOLATION: teleportToPlayer needs both names — got bot='${botName}' player='${playerName}'.`);
  }
  // A NAME THAT IS NOT A NAME IS A SELECTOR. Minecraft reads `@a`, `@e` and friends as targets, so an
  // unvalidated name reaching this command could teleport every entity on the server to one place, or a
  // bot into a target it was never meant to reach. Vanilla usernames are 3-16 of [A-Za-z0-9_] and nothing
  // else, so the check is exact rather than a denylist of the selectors known today (Law 27 — constitute
  // what a name IS; do not police the list of things it must not be).
  const NAME = /^[A-Za-z0-9_]{3,16}$/;
  for (const [label, value] of [['bot', botName], ['player', playerName]]) {
    if (!NAME.test(value)) {
      throw new Error(`[${TAG}] CODING VIOLATION: teleportToPlayer was handed a ${label} name that is not a `
        + `Minecraft username: '${value}'. A selector reaching \`tp\` moves bodies nobody named.`);
    }
  }
  // A REAL BOUNDARY, same as Act 2: the throw originates in the rcon package behind rcon_link.
  const sent = await guardExternal(TAG, `rcon tp ${botName} -> ${playerName}`,
    () => require('./utils/rcon_link').once([`tp ${botName} ${playerName}`]));
  if (!sent.ok) return { sent: false, error: `rcon: ${sent.reason}` };
  return { sent: true, error: null };
}

// anchorZeroPoint(blueprintName, buildCenter) → the world cell of anchor 0's FLOOR, or null.
//
// HERE rather than in either caller because both of them derive it and a disagreement about where home
// is would send two recoveries to two different places while both logs read "recovered to anchor 0".
// The blueprint's anchor carries a position relative to the build centre, so the world cell is the sum.
function anchorZeroPoint(blueprintName, buildCenter) {
  const building = require('@kernel/blueprint_registry').tryGetBuilding(blueprintName);
  const anchor = building && Array.isArray(building.anchors) ? building.anchors[0] : null;
  if (!anchor || !Array.isArray(anchor.position) || anchor.position.length < 3) return null;
  const [dx, dy, dz] = anchor.position;
  return { x: buildCenter.x + dx, y: buildCenter.y + dy, z: buildCenter.z + dz };
}

module.exports = {
  isDead, awaitKnownHealth, reviveBody, teleportTo, teleportToPlayer, anchorZeroPoint,
  ARRIVAL_TOLERANCE, HEALTH_WAIT_MS, RESPAWN_WAIT_MS, TELEPORT_WAIT_MS,
};
