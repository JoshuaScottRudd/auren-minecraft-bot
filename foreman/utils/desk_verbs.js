'use strict';
// foreman/utils/desk_verbs.js — the chat vocabulary: what a person can say to the foreman and how it answers.
//
//   bind({ door, getBot })       the foreman's recorded door and its body
//   handle(from, text, reply)    parses one line of chat and answers it (`get` hands off to get_crew.getCrew)

const { FOREMAN_PREFIX } = require('@thinking/architect_config');
const record = require('../foreman_record');
const { log } = require('./say');
const { getCrew } = require('./get_crew');
// The third outcome at the human boundary: a malformed word is corrected, not thrown or soft-failed
// (Law 13, Law 26) — the doctrine lives in correction.js.
const correction = require('../correction');

let door = null;
let getBot = () => null;
function bind(c) { ({ door, getBot } = c); }

// ── WIPE REQUIRES TWO SAYINGS ─────────────────────────────────────────────────
// The one irreversible word a player has; the confirmation window expires so the arming stays a fact
// about the current moment, not a stale one (Law 13).
const WIPE_CONFIRM_MS = 60000;
// player -> the moment their armed wipe stops counting; keyed per person.
const wipeArmed = new Map();

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The vocabulary
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// `get`/`list`/`help` are clerk words that spawn a process; every operator verb travels the in-game door
// instead (Law 16). Lives in its own file since this module creates a mineflayer client at load time.
const { INGAME_VERBS, CREW_SIZE, SPECIES, helpLines, parseRequest, parseCancel,
  pluralForms, describeAge, describeProgress, describeCrew } = require('../foreman_vocabulary');

// ── NO FUZZY MATCHER ───────────────────────────────────────────────────────
// Publishes the legal vocabulary and refuses anything not in it (Law 13); plural is the one forgiveness,
// tried as an exact lookup, never a fuzzy match.
const { isRequestable, isBlueprint } = require('@kernel/requestable_catalogue');

// resolveExact(spoken) → the legal token, or null: the word, then its plural forms, checked against the
// catalogue itself.
function resolveExact(spoken) {
  for (const candidate of [spoken, ...pluralForms(spoken)]) {
    if (candidate && isRequestable(candidate).ok) return candidate;
  }
  return null;
}

// knownName(spoken) → the spelling the fleet recognises, or null: membership, not obtainability, so a
// real item with no route (e.g. `string`) still resolves here (Law 25).
function knownName(spoken) {
  const { group_to_item } = require('@utils/fragment_utils');
  const catalogue = require('@kernel/requestable_catalogue');
  const known = new Set([
    ...catalogue.requestableItems(),
    ...Object.keys(group_to_item),
    ...catalogue.unreachableLeaves(),
    ...catalogue.unclassifiedLeaves(),
  ]);
  for (const candidate of [spoken, ...pluralForms(spoken)]) if (candidate && known.has(candidate)) return candidate;
  return null;
}

// groupMembers(token) → the family's members, or null if the token names one thing; reads the assessors'
// own group table (Law 16).
function groupMembers(token) {
  const { group_to_item } = require('@utils/fragment_utils');
  const members = group_to_item[token];
  return Array.isArray(members) && members.length ? members : null;
}

// raisableStructures() → the buildings a person may ask for, read from architect_config's own
// REQUESTABLE_STRUCTURES (Law 27).
function raisableStructures() {
  return [...require('@thinking/architect_config').REQUESTABLE_STRUCTURES].sort();
}

async function handle(from, text, reply) {
  const bot = getBot();
  const parts = text.split(/\s+/).filter(Boolean);
  const verb = (parts[0] || 'help').toLowerCase();
  const arg = parts[1];
  record.read_as(from, verb);

  // correct(c) — the one way a refusal reaches a person; also logs it, since the fleet's own trace never
  // carries these (Law 16, Law 6).
  const correct = (c) => {
    record.refused(from, c.code, c.said);
    log(`correction[${c.code}] to ${from}: ${c.said ? `'${c.said}' — ` : ''}${c.because}`);
    for (const line of correction.render(c)) reply(line);
  };

  // ── trouble(who, code, forThePerson, forTheLog) — the desk's own faults, kept off open chat ─────────
  // `forThePerson` is one plain sentence with no cause; `forTheLog` is the full machine half, sent to the
  // desk's window and record — not a correction, since the fault is the desk's, not the person's (Law 24, Law 6, Law 13).
  const trouble = (who, code, forThePerson, forTheLog) => {
    log(`trouble[${code}] serving ${who}: ${forTheLog}`);
    reply(forThePerson);
  };

  if (verb === 'help' || verb === '') {
    // One message per verb, so a person can find the one they want in the wall of chat.
    for (const line of helpLines()) reply(line);
    return;
  }

  if (verb === 'get') {
    // Hands out a crew of CREW_SIZE, never a chosen count or a named bot (Law 16); the count is asked of
    // the fleet, never tallied here (Invariant B). Species is checked first since it costs nothing.
    const species = (arg || '').toLowerCase();
    if (!SPECIES.includes(species)) {
      correct(correction.getNeedsASpecies(`${FOREMAN_PREFIX} get${arg ? ` ${arg}` : ''}`));
      return;
    }
    await getCrew(from, species, { reply, correct, trouble });
    return;
  }

  // ── WHERE: THE ASKER'S OWN BODIES, AND WHAT EACH IS DOING ───────────────────────────────────────
  // Scoped to the asker. Nothing is sensed or computed about the work itself (Law 3) — every field
  // already travels; this desk computes only the distance and bearing to the person asking.
  if (verb === 'where') {
    const state = await door.query();
    if (!state.ok) {
      trouble(from, 'fleet_unreachable', "can't reach your bots right now — try again in a moment.",
              `door.query failed on where: ${state.error}`);
      return;
    }
    const mine = state.bots.filter(b => b.owner === from);
    if (mine.length === 0) { correct(correction.noBotsOut(`${FOREMAN_PREFIX} where`)); return; }

    // Read, never assumed: an unloaded speaker entity passes through as null, and describeCrew falls
    // back to coordinates, never an invented figure (Law 25).
    const speaker = bot.players?.[from]?.entity?.position || null;
    const speakerPos = speaker ? { x: Math.floor(speaker.x), y: Math.floor(speaker.y), z: Math.floor(speaker.z) } : null;

    // One reply for the crew, never one per body (see describeCrew).
    reply(describeCrew(mine, speakerPos));
    log(`where for ${from} -> ${mine.map(b => b.id).join(', ')}${speakerPos ? '' : ' (speaker not in view — no bearing)'}`);
    return;
  }

  // ── TELEPORT: TAKE ME TO WHERE THE CREW WORKS ────────────────────────────
  // The second half of `where`, closing the distance/bearing gap by moving the asker there; touches no
  // body. The server console performs it via `foreman_world.consoleCommand` (Law 6); the anchor is read
  // off `desk.alphaSpot`, never surveyed, so a world with no crew raised has none to send anyone to (Law 25).
  if (verb === 'teleport') {
    // The hub, not the door: no body is involved in this verb.
    const spot = require('../foreman_hub').desk.alphaSpot();
    if (!spot) {
      reply(`${from}: nothing is sited yet — say "${FOREMAN_PREFIX} get <species>" first and I will have somewhere to send you.`);
      log(`teleport for ${from} -> refused, no alpha structure sited`);
      return;
    }
    // Feet on the anchor cell, one block up so the arrival is never inside a placed block.
    const sent = require('../foreman_world').consoleCommand(`tp ${from} ${spot.x} ${spot.y + 1} ${spot.z}`);
    if (!sent.sent) {
      trouble(from, 'no_console', `I can't teleport you here — ${sent.reason}. The ${spot.structure} is at ${spot.x}, ${spot.y}, ${spot.z}.`,
              `teleport refused: ${sent.reason}`);
      return;
    }
    reply(`${from}: sending you to the ${spot.structure} — ${spot.x}, ${spot.y}, ${spot.z}.`);
    log(`teleport for ${from} -> ${spot.structure} (${spot.x},${spot.y + 1},${spot.z})`);
    return;
  }

  // ── REQUEST: THE ONE VERB THAT IS NOT A COMMAND ─────────────────────────────────────────────────
  // Writes a fact down and tells nobody; crews find it on their own next measure, so it takes its own
  // door, not an operator verb. Gathering, crafting and building are one word, computed from the item.
  if (verb === 'request') {
    const parsed = parseRequest(parts);
    if (parsed.kind === 'status') {
      const r = await door.request('status', {}, from);
      if (!r.ok) {
        trouble(from, 'fleet_unreachable', "can't read your list right now — try again in a moment.",
                `door.request status failed: ${r.error || r.reason}`);
        return;
      }
      const rows = Array.isArray(r.rows) ? r.rows : [];
      if (rows.length === 0) { reply(`you haven't asked for anything. try "${FOREMAN_PREFIX} request 20 logs".`); return; }
      reply(`you have asked for ${rows.length} thing(s):`);
      // Relayed, never computed here: the desk holds no owner key, so an invented figure would be a
      // false claim (Law 25).
      const progress = (r.progress && typeof r.progress === 'object') ? r.progress : {};
      for (const row of rows) {
        // A structure is read back without its quantity, for the same reason it cannot be asked for with one.
        const named = isBlueprint(row.item) ? row.item : `${row.quantity} ${row.item}`;
        reply(`  ${named} — asked ${describeAge(row.first_asked_at)}${describeProgress(progress[row.item])}`);
      }
      return;
    }
    // ══ THE VEIL ══════════════════════════════════════════════════════════════════════════════════
    // Every gate below passes a typed value or corrects, cheapest-first, one question each (Law 26).

    // GATE 1 — the shape of the sentence: three mistakes, three separate corrections.
    if (parsed.kind === 'reversed') {
      correct(correction.wrongFormat(`${FOREMAN_PREFIX} request ${parsed.item.replace(/_/g, ' ')} ${parsed.quantity}`,
        `"${FOREMAN_PREFIX} request ${parsed.quantity} ${parsed.item.replace(/_/g, ' ')}" — the number comes first, then the thing.`));
      return;
    }
    if (parsed.kind === 'bad_quantity') {
      correct(correction.wrongFormat(parsed.said,
        `"${FOREMAN_PREFIX} request 20 logs" — a whole number above zero, then the thing.`));
      return;
    }
    if (parsed.kind === 'no_item') {
      correct(correction.wrongFormat(`${FOREMAN_PREFIX} request`,
        `"${FOREMAN_PREFIX} request 20 logs" — a number, then what you want.`));
      return;
    }

    // GATE 2 — the name: an exact lookup, nothing it accepts needs a reading confirmed.
    const item = resolveExact(parsed.item);
    if (item === null) {
      // Three refusals kept apart, e.g. spawn_box (a real structure not raisable alone), string (a real
      // material with no route) and logdsf (not a word), since one answer for all three would be wrong
      // for two of them (Law 13, Law 25).
      if (isBlueprint(parsed.item)) {
        correct(correction.noPlanForThat(parsed.item, raisableStructures()));
        return;
      }
      const known = knownName(parsed.item);
      if (known === null) {
        correct(correction.notOnTheList(parsed.item));
        return;
      }
      // Kept apart: a species refusal carries `askInstead` and no `blockedBy` (Law 25).
      const verdict = isRequestable(known);
      correct(verdict.askInstead
        ? correction.askByFamily(parsed.item, verdict.askInstead)
        : correction.cannotObtain(parsed.item, verdict.blockedBy));
      return;
    }

    // GATE 3 — a building is not a countable thing; it makes one. Both directions are corrected.
    const building = isBlueprint(item);
    if (building && parsed.quantity !== null) {
      correct(correction.buildingTakesNoNumber(`${parsed.quantity} ${parsed.item.replace(/_/g, ' ')}`, item));
      return;
    }
    if (!building && parsed.quantity === null) {
      correct(correction.goodNeedsANumber(parsed.item, item));
      return;
    }

    // GATE 4 — the same building twice while the first is still going up. Asked of the fleet, never
    // tallied here (Invariant B).
    if (building) {
      const standing = await door.request('status', {}, from);
      if (standing.ok) {
        const already = (standing.rows || []).some(row => row.item === item);
        const stage = ((standing.progress || {})[item] || {}).stage || 'not started';
        if (already && stage !== 'built') {
          correct(correction.alreadyUnderway(parsed.item, item, stage));
          return;
        }
      }
    }

    // A building is filed as one: its quantity is a storage detail never shown to the person (Law 0).
    const r = await door.request('post', { item, quantity: building ? 1 : parsed.quantity }, from);
    if (!r.ok) {
      if (r.reason === 'not_requestable') {
        correct(correction.cannotObtain(parsed.item, r.blockedBy));
      } else {
        // Not a correction — the fleet's fault, not the person's (Law 25).
        trouble(from, 'request_refused', "couldn't file that one — try again in a moment.",
                `door.request refused: ${r.reason || r.error}`);
      }
      return;
    }
    const note = r.replaced !== null && r.replaced !== undefined
      ? ` (was ${r.replaced} — a request is a target, not a tally, so this replaces it)` : '';
    // A family is not one thing: the crew picks by abundance, not preference.
    const family = groupMembers(r.item)
      ? ` ${r.item} is a family, not one block — your crew takes whichever of them is most abundant around here.` : '';
    // Confirmed without its number, for the same reason it is read back without one.
    reply(building
      ? `right — your crew will raise the ${r.item}. it goes up once, and "${FOREMAN_PREFIX} request" tells you how far along it is.`
      : `right — ${r.quantity} ${r.item}${note}. your crew will pick it up on its next pass.${family}`);
    return;
  }

  if (verb === 'cancel') {
    const parsed = parseCancel(parts);
    if (parsed === null) {
      reply(`name what to drop: "${FOREMAN_PREFIX} cancel logs" or "${FOREMAN_PREFIX} cancel all".`);
      return;
    }
    // Same plural forgiveness, nothing more; an unrecognised word gets "nothing of yours matched" rather
    // than a spelling refusal (Law 25).
    const target = parsed.item === 'all' ? 'all' : (resolveExact(parsed.item) || parsed.item);
    const r = await door.request('cancel', { item: target }, from);
    if (!r.ok) {
      trouble(from, 'fleet_unreachable', "couldn't cancel that right now — try again in a moment.",
              `door.request cancel failed: ${r.error || r.reason}`);
      return;
    }
    reply(r.removed === 0
      ? `nothing of yours matched '${target}'.`
      : `dropped ${r.removed} request(s).`);
    return;
  }

  if (INGAME_VERBS.has(verb)) {
    // Every verb hits all of the asker's bots and nothing else; no in-game verb carries a payload.
    // Wipe is held back on its first hearing so an unconfirmed wipe never reaches the fleet.
    if (verb === 'wipe') {
      const now = Date.now();
      const armed = wipeArmed.get(from);
      if (!armed || armed < now) {
        wipeArmed.set(from, now + WIPE_CONFIRM_MS);
        reply(`wipe forgets your base — your crew stops and resettles where you next stand. say wipe again to confirm.`);
        return;
      }
      // Spent on use, so a third `wipe` is a fresh warning, not a second silent wipe.
      wipeArmed.delete(from);
    }

    const r = await door.send(verb, {}, from);
    const said = describeDoorResult(verb, r);
    log(`${verb} for ${from} -> ${said}`);
    reply(said);
    return;
  }

  reply(`don't know '${verb}'. say "${FOREMAN_PREFIX} help".`);
}

// describeDoorResult — turns the fleet's verdict into a sentence. Never says "done" for a delivery, only
// "sent to N" (Law 25); each refusal names its own cause.
function describeDoorResult(verb, r) {
  if (!r.ok) return `couldn't reach the fleet: ${r.error}`;
  // A wipe reports on memory, not delivery; `sent: 0` is its normal result, not a failure.
  if (r.reason === 'wiped') {
    return r.stopped > 0
      ? `wiped. your ${r.stopped} bot${r.stopped === 1 ? '' : 's'} left — say "${FOREMAN_PREFIX} get" and a new crew settles where you are.`
      : `wiped. say "${FOREMAN_PREFIX} get" and your crew settles where you are.`;
  }
  if (r.sent > 0) return `${verb} sent to your ${r.sent} bot${r.sent === 1 ? '' : 's'}.`;
  switch (r.reason) {
    // Ordered by what the human should do next.
    case 'not_yours':
      return `none of those are yours — every bot out here belongs to someone else. `
           + `say "${FOREMAN_PREFIX} get" and I'll fetch you one.`;
    case 'not_a_contractor':
      return `the bots out here answer to nobody — a homesteader takes no orders from in here. `
           + `say "${FOREMAN_PREFIX} get" and I'll fetch you one of your own.`;
    case 'no_bots':      return `no bots are up. say "${FOREMAN_PREFIX} get" and I'll fetch you one.`;
    case 'reached_nobody': return `you have no bots out. say "${FOREMAN_PREFIX} get" and I'll fetch you one.`;
    case 'unknown_verb': return `the fleet doesn't know '${verb}'.`;
    // The verb exists and is not a human's to say (distinct from unknown_verb); the desk's own gate
    // should never produce this.
    case 'not_ingame_verb': return `'${verb}' isn't something you can ask for in here — it's an operator command.`;
    case 'no_asker':     return `I couldn't tell the fleet who you are, so it refused. that's my fault, not yours.`;
    default:             return `${verb} reached nobody.`;
  }
}

module.exports = { bind, handle };
