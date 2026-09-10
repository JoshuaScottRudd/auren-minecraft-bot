// fragment: ground_salvage_executor — go pick up the useful thing lying in the yard, or say why not.
//
// ── THE SEAT ─────────────────────────────────────────────────────────────────────────────────────────
// ground_drop_scanner owns WHAT IS WORTH HAVING (valuable, on the ground, inside the base radius) and the
// board owns WHETHER IT IS OFFERED. This owns WHETHER THE WALK IS AFFORDABLE and does the walking. The
// split is forced rather than stylistic: job_board's sweep is synchronous and a route price is async —
// the same constraint that shaped the retired death_pile_executor, and the one part of that design worth
// carrying forward.
//
// ── WHAT THIS REPLACES, AND WHAT IT DELIBERATELY DROPS ──────────────────────────────────────────────
// Replaces death_pile_executor + death_pile_recorder + death_pile_ledger with a flat drop scan. Three of
// their four gates survive here in some form; one is gone on purpose:
//
//   REACHABLE   — kept, unchanged, still through drop_collector.priceRouteTo (Law 16: the same search
//                 that will do the walking answers whether it can).
//   IN TIME     — kept. A dropped item despawns on the server's five-minute clock whether a bot died or
//                 not, so arriving late is still arriving at bare ground.
//   WORTH IT    — MOVED, not dropped. The old fragment priced the pile's contents against the fleet's
//                 stock deficit after a claim; the scanner now asks the same question (same
//                 STOCK_THRESHOLDS, same group-aware match) BEFORE the job is ever posted, so a
//                 worthless drop costs no dispatch at all rather than a dispatch and a decline.
//   THE LEDGER  — GONE, and this is the whole point of the change. It held "a bot died here" as
//                 remembered state and re-offered graves the world had already reaped. A live entity scan
//                 cannot produce a ghost (ground_drop_scanner's header carries the argument in full).
//
// ── THE ONE THING A LIVE SCAN STILL NEEDS A MEMORY FOR (Law 8) ──────────────────────────────────────
// A drop that is genuinely unreachable stays in `bot.entities` for its full five minutes, so a board that
// re-offered it every sweep would re-price the same impossible route until it despawned — a message with
// no termination point, which is the same infinite offer the ledger's refusal rows existed to end.
//
// So the refusal survives, in the smallest form that works: a module-scope Map keyed by ENTITY ID, not by
// position. That key is what makes it self-cleaning rather than a second ledger — an id belongs to one
// item stack for its whole life and is never reissued while that stack exists, so a refusal expires by
// the drop ceasing to exist rather than by anything here reaping it. No file, no office, no broadcast
// (Law 9: temporary state belongs in a module variable). The stale sweep below is a leak guard, not a
// lifetime: nothing consults an entry older than the despawn window because the entity behind it is gone.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');
const {
  RETRIEVAL_ARRIVAL_MARGIN_MS,
  RETRIEVAL_MS_PER_COST_UNIT,
  ITEM_DESPAWN_MS,
} = require('@thinking/architect_config');

const TAG = 'ground_salvage_executor';

const SWEEP_DRY_PASSES = 2;
const SWEEP_MAX_PASSES = 6;   // runaway guard, not a tuning dial: the dry-pass judge is the real terminator

// entityId → { reason, at }. See the header for why the key is the id.
const _refused = new Map();

function noteRefusal(id, reason, now) {
  _refused.set(id, { reason, at: now });
  // Bounded by construction: an entry can only be consulted while its entity lives, and no entity lives
  // past the despawn window. Swept on write so the map cannot grow across a long run (Law 8).
  for (const [k, v] of _refused) if (now - v.at > ITEM_DESPAWN_MS) _refused.delete(k);
}

// isRefused(id) — read by job_board's sweep so a declined drop stops being offered. Exported rather than
// duplicated there because the decision and its memory belong to the same seat (Invariant D).
function isRefused(id) {
  return _refused.has(id);
}

// Two consecutive empty passes, or the pass ceiling. Returns what came back so the verdict reports the
// TRUE haul rather than the intent (Law 25) — arriving to bare ground is a real outcome, not a failure.
//
// TWO, NOT ONE: a single empty pass happens legitimately when the bot arrives a step short and the next
// pass closes it. Two consecutive is the judge that separates "still working" from "circling", which
// neither an empty-box test nor a timeout catches early (Law 11 — one judge per loop).
async function sweepHere(bot) {
  const { collectNearby } = require('@api/drop_collector.js');
  let picked = 0, dry = 0, passes = 0;
  while (dry < SWEEP_DRY_PASSES && passes < SWEEP_MAX_PASSES) {
    passes++;
    const r = await collectNearby(bot);
    const got = r.picked_up || 0;
    picked += got;
    dry = got > 0 ? 0 : dry + 1;
  }
  return { picked, passes };
}

module.exports = {
  isRefused,
  sweepHere,

  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    if (!bot) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before ground salvage ran.`);

    // Drop the pile off before handing back — offloading is a step at the end of every producing verb now,
    // not a job (job_board SECTION 4.5). Salvage is the seat that most needs it: this verb exists to scoop
    // up what a DEATH scattered, so it is the one place a bot reliably ends holding a couple of hundred
    // items it did not choose, and carrying them to the next job is how the same pile gets dropped twice.
    // Awaited BEFORE routeToJudge — routing dispatches, so anything awaited past it races the judge's next
    // dispatch (same seam as the gather and craft sides).
    const finish = async (readable) => {
      watcher.summary(TAG, readable);
      const capsule = payload[TAG] || (payload[TAG] = {});
      capsule.readable = readable;
      // `abandoned` = the drop-off already routed to the judge (Law 15). Guards a race where two bots
      // reach the same buffer at once: if the open fails and this routed again, it would put two live
      // signals in one scope (Law 4).
      const drop = await require('@api/inventory_swapper').dropOffHaul(bot);
      if (drop?.abandoned) return;
      return routeToJudge(TAG, { ...payload, readable });
    };

    // The dispatcher routes the whole job object, so the drop identity rides on payload.job rather than
    // the magnet (a deliberate field whitelist). Missing means the board posted a malformed job: a coding
    // violation, never soft-handled (Law 13).
    const job = payload.job || {};
    const dropId = job.drop_id;
    if (dropId === undefined || dropId === null) {
      throw new Error(`[${TAG}] CODING VIOLATION: dispatched with no job.drop_id in the payload.`);
    }

    const now = Date.now();
    // RE-SENSED, never taken from the job (Invariant B). The board saw this drop one sweep ago and the
    // whole reason this design beats the ledger is that the world is asked again at the moment of acting:
    // a drop collected by a peer or despawned in between is simply not here, and that is not a failure.
    const live = (bot.entities || {})[dropId];
    if (!live || !live.position) {
      return finish(`${TAG}: drop ${dropId} is gone (picked up by a peer, or despawned) — nothing to do`);
    }
    const at = { x: live.position.x, y: live.position.y, z: live.position.z };

    // ── GATE 1: is there a route ──
    const { priceRouteTo } = require('@api/drop_collector.js');
    const priced = await priceRouteTo(bot, at, ITEM_DESPAWN_MS);
    if (!priced.reachable) {
      // A complete search PROVED no route; an incomplete one only ran out of clock. Both decline this
      // dispatch, and only the PROOF is worth remembering — banning a target on an incomplete search bans
      // a place nothing ever finished looking for (pathfinding_utils' verdict table).
      if (!priced.complete) {
        return finish(`${TAG}: could not finish pricing drop ${dropId} (${job.what}) before the clock — not refused, the next sweep re-asks`);
      }
      noteRefusal(dropId, 'no route', now);
      return finish(`${TAG}: DECLINED drop ${dropId} (${job.what}) — no route to it exists in the world this bot can see; it will not be offered again while it lasts`);
    }

    // ── GATE 2: can it get there before the drop despawns ──
    // Measured against the FULL despawn window rather than a remaining one, and that is a real weakness
    // stated rather than hidden: a live scan knows an item exists, never when it hit the ground, so the
    // clock here is the most optimistic reading of it. The old ledger knew the drop moment because a
    // death is an event it recorded — this design traded that one fact for the ghost-freedom the header
    // argues is worth more. The margin below is what absorbs the difference.
    const travelMs = priced.cost * RETRIEVAL_MS_PER_COST_UNIT;
    if (travelMs + RETRIEVAL_ARRIVAL_MARGIN_MS > ITEM_DESPAWN_MS) {
      noteRefusal(dropId, 'too far', now);
      return finish(`${TAG}: DECLINED drop ${dropId} (${job.what}) — a route costing ~${Math.round(travelMs / 1000)}s cannot beat the ${Math.round(ITEM_DESPAWN_MS / 1000)}s despawn clock; it would arrive to bare ground`);
    }

    watcher.summary(TAG, `🧲 Taking ${job.what} at (${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)}) — route ${Math.round(priced.cost)}. Hauling.`);

    // goTo owns its own abandonment (Law 15 nested API): if it cannot reach the drop it starts a fresh
    // chain at recursive_judge and this await never resolves. No timeout or retry is added here — the
    // inner API's clause already covers the whole nest, and a second one would be the duplicate failure
    // handling Law 15 explicitly forbids an outer API from adding.
    const dispatcher = require('@locomotion/locomotion_dispatcher');
    await dispatcher.goTo(at);

    const { picked, passes } = await sweepHere(bot);

    // REFUSED EVEN ON A SUCCESSFUL TRIP THAT PICKED UP NOTHING. The bot STOOD on the spot and swept it, so
    // re-offering the same drop is precisely the zombie job this fragment's memory exists to end — and a
    // sweep that came back empty from ground the bot was standing on is the strongest evidence there is
    // that the offer was wrong. A trip that DID recover something needs no entry: the stack it took is
    // gone from the entity table, so the scan stops offering it by itself.
    if (picked === 0) noteRefusal(dropId, 'swept dry', now);

    return finish(`${TAG}: swept ${job.what} at (${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)}) in ${passes} pass(es) — recovered ${picked} item(s)` +
      `${picked === 0 ? ' (arrived to bare ground: despawned, or a peer got there first)' : ''}`);
  }),
};
