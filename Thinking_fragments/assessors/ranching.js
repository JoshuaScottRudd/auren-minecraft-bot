// assessors/ranching — each of the crew's pens: one herd at a time while the pen lacks animals, a shepherd for every
// tender at the gate, a pair bred in a wool pen only when no animal is left to herd and in a meat pen from two penned; in a wool pen the fleet's one pair of shears, the
// flock dyed in proportion to the wool the building waits on, and a shearing of one color once every animal of it is
// woolly; in a meat pen, once full, the grown animals past its breeding stock culled for meat and hide.
// See assessor_registry.

'use strict';

const hq = require('@kernel/corporate_headquarters');
const watcher = require('@kernel/watcher');
const { writeCensus, penOf, penGeometry, penned, keptPen, parkedTender, shepherdOf, phaseOf, CALLING_PHASES, breedRoundOf, flockOf, herdsUnderway, tendingUnderway, askWool, noteWool, woolSeen } = require('@api/pen_gate');
const { supplyJob } = require('@thinking/assessors/shared');
const { homeChest } = require('@utils/fragment_utils');

// Tunables imported from architect_config, never restated (Law 16 — one source).
const { JOB_TYPE, HERDING, FARM_PENS, DYES } = require('@thinking/architect_config');
const { woolOwed, flockTarget } = require('@api/flock_colors');

// The wheat a body may take from the chests: what retrieveItems will hand it, every peer's claim taken out
// (inventory_swapper reads the same chest_ledger count before it walks). Counted any other way, the board offers a
// herd the fetch then refuses at once (no wheat in the chests) and the job is claimed and dropped again.
const wheatInChests = () => require('@perception/chest_ledger').unclaimedOf(['wheat']);

// dyeOrder(structure, dye, want, banked) → the pen's shared supply seat for one dye, delivered to the home chest the
// dyer pulls from: the seat counts the dye the chests hold, so a dye made and kept in a pocket would leave it open and
// post it again to the same body. Null with no home chest to deliver to.
function dyeOrder(structure, dye, want, banked) {
    const chest = homeChest();
    if (!chest) return null;
    return supplyJob({
        id: `pen_supply_${dye}`, what: dye, need: want - banked,
        where: chest.station.pos, station_id: chest.id, destination: 'storage',
        structure, job_type: JOB_TYPE.site_supply, claimed_by: null,
        hold_goal: want, at_destination: banked,
        parts: [{ who: `blueprint:${structure}_dye`, amount: want }],
        category: 'crafting', action: 'deliver', scope: 'shared',
    });
}
// This body's memory of each pen, by structure: when it last warned, said the census, asked the server; and, in a wool
// pen, whether dyeing has begun: once a dye job or a dye supply has been posted, this body breeds no more there, since a
// lamb is born white and would unbalance the colors the flock was dyed to.
const _pens = new Map();
const penState = structure => _pens.get(structure)
    || _pens.set(structure, { shortWarnedAt: 0, censusSaid: null, woolAskedAt: 0, heldSaid: null, dyeingStarted: false }).get(structure);

// assess — posts each pen's jobs once that pen (architect_config FARM_PENS) is built. A pen's jobs carry its structure,
// and their ids its place in the crew's list (#1, #2), so each pen's seats are its own.
async function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot?.entity?.position) return { jobs };
    for (let k = 0; k < FARM_PENS.length; k++) jobs.push(...await assessPen(bot, FARM_PENS[k], k + 1));
    return { jobs };
}

// assessPen(bot, structure, n) → the jobs of one pen.
//
// THE FLOCK IS THE PEN'S SIZE: HERDING.grass_per_animal cells of interior per animal. The penned count is
// sensed from the animals standing inside (Invariant B), so a body too far from the pen to see into it posts
// nothing rather than guess (HERDING.sense_pen_blocks).
//
// TENDING (pen_gate): every piece of work that opens the gate is a tender at the standby cell and a shepherd holding the
// penned flock from the post. One tender at a time: a herd is not posted while a peer shears, nor a shearing while a
// peer herds. The shepherd job is posted once a tender holding the standby cell says it is near it or standing by
// (pen_gate.CALLING_PHASES), with no shepherd. A herd needs two wheat in this body's reach, its pocket and the
// chests': the bringer's and its shepherd's.
async function assessPen(bot, structure, n) {
    const jobs = [];
    if (hq.readBuildingChair(structure, 'building_integrity')?.all_complete !== true) return jobs;
    const pen = penOf(structure);
    if (!pen) return jobs;
    const row = HERDING.pens[structure];
    const animal = pen.animal;
    const st = penState(structure);
    const geo = penGeometry(pen);
    const i = geo.interior;
    const mid = { x: (i.x1 + i.x2 + 1) / 2, z: (i.z1 + i.z2 + 1) / 2 };
    if (Math.hypot(bot.entity.position.x - mid.x, bot.entity.position.z - mid.z) > HERDING.sense_pen_blocks) return jobs;

    const selfId = process.env.BOT_ID || 'default';
    const pocketWheat = bot.inventory.items().some(it => it.name === 'wheat');
    const tender = parkedTender(bot, geo, selfId);
    // THE SHEPHERD JOB: a tender near the standby cell with no shepherd will wait on one; urgent (the preconditions band),
    // one at a time.
    if (tender && CALLING_PHASES.has(phaseOf(geo, tender.id)) && !shepherdOf(bot, geo, selfId) && (pocketWheat || wheatInChests() > 0)) {
        jobs.push({
            id: `shepherd_pen#${n}`, type: 'shepherd', what: 'shepherd_pen', where: { ...geo.gate },
            why: `${structure}: ${tender.id} stands by at the gate with no shepherd`,
            job_type: JOB_TYPE.shepherd_pen, structure, scope: 'shared', claimed_by: null,
        });
    }

    const flock = flockOf(geo);
    // THE KEEPER'S CENSUS IS THE PEN'S COUNT (pen_keeper, through pen_gate.keptPen): one count for the crew, watched
    // animal by animal. A pen the keeper does not see is unknown: nothing is posted on it. A body with no foreman
    // counts the pen itself.
    const kept = keptPen(structure);
    if (kept && !kept.seen) return jobs;
    const inPen = kept ? kept.count : penned(bot, geo, animal).length;
    // The animals a peer is leading in are counted as come: the pen asks for what is still missing past them.
    const leading = herdsUnderway(selfId, structure);
    const othersTending = tendingUnderway(selfId, structure) - leading;
    const missing = flock - inPen - leading;
    // ANOTHER PEN'S ANIMAL INSIDE THIS FENCE IS KILLED (pen_keeper PEN_STRANGER): one culler, the strangers named by
    // id, entering as every tender does, while no peer tends or leads at the pen. Any pen, meat or wool. It waits on a
    // shepherd, and the shepherd job above is posted only with wheat in reach, so with none the cull waits too.
    const missedStrangers = require('@api/pen_gate').strangersMissed(structure);
    const strangers = (kept && Array.isArray(kept.strangers) ? kept.strangers : []).filter(id => !missedStrangers.has(Number(id)));
    if (strangers.length && !tender && leading === 0 && othersTending === 0 && !shepherdOf(bot, geo, selfId)
        && (pocketWheat || wheatInChests() > 0)) {
        jobs.push({
            id: `cull_stranger#${n}`, type: 'cull', what: 'cull_animal', need: strangers.length, strangers, where: { ...geo.gate },
            why: `${structure} holds ${strangers.length} animal(s) another pen keeps (${strangers.join('/')}); killed where they stand`,
            job_type: JOB_TYPE.cull_animal, structure, scope: 'shared', claimed_by: null,
        });
    }

    // THE PEN'S PAIR OF SHEARS is the kit's (STOCK_THRESHOLDS shears row), banked and only borrowed: the shearer takes
    // one from the chest, shears, and puts it back with the wool (shear_manager).

    // WOOL IS REQUEST ONLY: the building's set-aside wool blocks (flock_colors.woolOwed), less what the fleet holds. With
    // nothing owed the pen is neither asked, dyed nor shorn. Read from the pen's first day, empty or not: the dyes are
    // ordered ahead of the flock (below).
    const owed = row.wool ? woolOwed() : {};
    const colorsOwed = Object.keys(owed).sort((a, b) => owed[b] - owed[a]);
    // THE PEN'S COLORS: the server is asked which penned animals are woolly and their colors at most every
    // HERDING.wool_ask_ms (pen_gate.askWool), by any body near the pen while wool is owed; a shearer's or dyer's own
    // count after its work stands until then.
    if (colorsOwed.length && inPen >= HERDING.shear_min && Date.now() - Math.max(st.woolAskedAt, woolSeen(geo)?.at || 0) >= HERDING.wool_ask_ms) {
        st.woolAskedAt = Date.now();
        const asked = await askWool(penned(bot, geo, animal));
        if (asked) noteWool(geo, asked);
    }
    const wool = woolSeen(geo);
    const woolly = wool?.woolly ?? 0;
    const byColor = wool?.byColor || {};
    const quiet = !tender && leading === 0 && (pocketWheat || wheatInChests() > 0);

    // THE SHEARING, ONE COLOR AT A TIME: posted by any body near the pen while a pair of shears is in its pocket or the
    // chests, for the most-owed color whose every penned animal is woolly, so the gate opens for that color once per
    // regrowth. what = '<color>_wool' (shear_manager).
    const shearsReach = bot.inventory.items().some(it => it.name === 'shears') || require('@perception/chest_ledger').unclaimedOf(['shears']) > 0;
    const shearColor = shearsReach && quiet ? colorsOwed.find(c => byColor[c]?.penned > 0 && byColor[c].woolly === byColor[c].penned) : null;
    if (shearColor) {
        jobs.push({
            id: `shear_pen#${n}`, type: 'shear', what: `${shearColor}_wool`, where: { ...geo.gate },
            why: `${structure}: all ${byColor[shearColor].penned} ${shearColor} ${animal} woolly; ${owed[shearColor]} ${shearColor} wool owed`,
            job_type: JOB_TYPE.shear_animal, structure, scope: 'shared', claimed_by: null,
        });
    }

    // THE DYEING: once the pen is full, its animals are dyed in proportion to the wool owed (flock_colors.flockTarget), one
    // color at a time from the white animals. With the dye in the chests a dyer is posted (dye_manager); without it the
    // dye is asked for as one shared supply seat, made or gathered by the fleet (brown from cocoa beans, a jungle trip).
    // A color whose dye has no fleet source (DYES ease 'hard': gray and black need an ink sac) is held and said once.
    // THE DYES ARE ORDERED AHEAD OF THE FLOCK: while the pen fills, each color the full flock will be dyed (flockTarget
    // of the pen's size) is asked for as its shared supply seat, less the dye already banked and the animals already
    // that color, so a trip dye (cocoa beans, an ink sac dived for off a squid) is fetched while the herd runs. The
    // seat's id is the dyeing's own (below), one seat per dye; nothing here starts the dyeing.
    if (colorsOwed.length && inPen < flock) {
        const { target } = flockTarget(flock, owed);
        for (const color of Object.keys(target).filter(c => c !== 'white' && target[c] > 0)) {
            const dye = DYES[color].dye;
            const want = target[color] - (byColor[color]?.penned || 0);
            const banked = require('@perception/chest_ledger').unclaimedOf([dye]);
            if (want <= banked) continue;
            const order = dyeOrder(structure, dye, want, banked);
            if (order) jobs.push(order);
        }
    }
    if (colorsOwed.length && wool && inPen >= flock) {
        const { target, held } = flockTarget(inPen, owed);
        const heldText = held.map(h => `${h.color} (${h.why})`).join('; ');
        if (heldText && heldText !== st.heldSaid) { st.heldSaid = heldText; watcher.warn('ranching', `${structure}: wool owed in colors the fleet cannot dye yet: ${heldText}`); }
        const white = byColor.white?.penned || 0;
        const color = white > 0 ? Object.keys(target).filter(c => c !== 'white').sort((a, b) => target[b] - target[a])
            .find(c => target[c] > (byColor[c]?.penned || 0)) : null;
        if (color) {
            const count = Math.min(white, target[color] - (byColor[color]?.penned || 0));
            const dye = DYES[color].dye;
            const inChests = require('@perception/chest_ledger').unclaimedOf([dye]);
            st.dyeingStarted = true;
            if (inChests > 0 && quiet && !shepherdOf(bot, geo, selfId)) {
                jobs.push({
                    id: `dye_pen#${n}`, type: 'dye', what: dye, need: Math.min(count, inChests), where: { ...geo.gate },
                    why: `${structure}: ${target[color]} of ${inPen} ${animal} should be ${color}, ${byColor[color]?.penned || 0} are; ${white} white`,
                    job_type: JOB_TYPE.dye_animal, structure, scope: 'shared', claimed_by: null,
                });
            } else if (inChests === 0) {
                // One asker: the pen's share of this color still white.
                const order = dyeOrder(structure, dye, count, 0);
                if (order) jobs.push(order);
            }
        }
    }

    // A herd needs an animal to fetch, asked as the herder asks it (animal_finder): one this body senses free outside
    // the pen, or somewhere the fleet's escalation can still look (sector_finder: a book sector recording the kind, or
    // a frontier sector inside the backstop not yet scanned). With neither, a slot would be claimed and given up at
    // once, again and again, until recursive_judge kills the loop.
    const seen = require('@api/animal_finder').nearestFree(bot, animal, [pen], new Set());
    const finder = require('@api/sector_finder');
    // The look past sight is the first ring of sectors round home (HERDING.reach_rings, sector_finder RINGS).
    const sectionsOpen = !finder.exhausted(finder.categoriesFor({ animal }), animal);
    const herdable = !!seen || sectionsOpen;
    // EVERY PEN FILLS BY HERDING AND BREEDING TOGETHER (HERDING.pens): it herds while it has room and an animal is
    // there to fetch, and from two penned it also breeds on the clock. A meat pen's census still says when it was first full.
    const meat = row.cull_keep !== null;
    const filledOnce = meat && (inPen >= flock || require('@api/pen_gate').censusOf(structure)?.filled_once === true);
    // AN ESCAPED ANIMAL IS FETCHED BACK whatever the pen's rule: the keeper names every one still in the world outside
    // the fence (pen_keeper `out`), and the pen herds while any is.
    const strays = kept && Array.isArray(kept.out) ? kept.out.length : 0;
    // A PEN WITH ITS HERDING STOCK (HERDING.pens herd_until) BREEDS THE REST: no wild animal is fetched past it.
    const herdStocked = row.herd_until !== null && inPen + leading >= row.herd_until;
    const herdWanted = (missing > 0 && !herdStocked) || strays > 0;
    // THE PEN'S CENSUS, said when it changes: how many it holds, of how many, and what it can still ask for. The same
    // count is written to HQ under the pen's building chair (pen_gate.writeCensus), the durable record any body reads.
    const colors = Object.entries(byColor).map(([c, n]) => `${c}:${n.woolly}/${n.penned}`).join(',') || '-';
    const census = `pen structure=${structure} animal=${animal} penned=${inPen} flock=${flock} free_seen=${seen ? 1 : 0} sections_open=${sectionsOpen} woolly=${woolly} colors=${colors} owed=${colorsOwed.map(c => `${c}:${owed[c]}`).join(',') || '-'}`
        + (meat ? ` filled_once=${filledOnce}` : '') + ` herding=${herdWanted} herd_until=${row.herd_until ?? '-'} strays=${strays}`;
    if (census !== st.censusSaid) {
        st.censusSaid = census;
        watcher.summary('pen_census', census);
        writeCensus(structure, { animal, penned: inPen, flock, woolly, by_color: byColor, owed, counted_by: selfId, filled_once: filledOnce });
    }
    // THE CULL, A FULL MEAT PEN ONLY: its grown animals past HERDING.pens cull_keep are slaughtered for meat and hide by
    // one tender with a shepherd holding the flock (cull_executor), while no peer tends the pen. The lambs are spared.
    if (row.cull_keep !== null && missing <= 0 && quiet && othersTending === 0 && !shepherdOf(bot, geo, selfId)) {
        jobs.push({
            id: `cull_pen#${n}`, type: 'cull', what: 'cull_animal', need: inPen - row.cull_keep, where: { ...geo.gate },
            why: `${structure} is full at ${inPen}/${flock} ${animal}; ${inPen - row.cull_keep} culled past a breeding stock of ${row.cull_keep}`,
            job_type: JOB_TYPE.cull_animal, structure, scope: 'shared', claimed_by: null,
        });
    }
    if (missing <= 0) return jobs;
    // NO ANIMAL TO FETCH AND TOO FEW TO BREED: the pen cannot fill, and that is said.
    if (!herdable && inPen < HERDING.breed_pair_min && Date.now() - st.shortWarnedAt >= HERDING.pen_short_warn_ms) {
        st.shortWarnedAt = Date.now();
        watcher.warn('ranching', `${structure} holds ${inPen}/${flock} ${animal}; no free ${animal} is sensed, no book sector records them and every frontier sector inside the backstop is scanned: the pen can neither herd nor breed`);
    }
    const pocket = pocketWheat ? 1 : 0;
    const chests = wheatInChests();
    // A body with no wheat of its own and none in the chests has nothing to lead with: the wheat its peers carry is
    // theirs, so a slot taken here would fail at once (herd_manager: no wheat in the chests) and repeat.
    if (pocket === 0 && chests === 0) return jobs;
    const wheat = chests + pocket;
    // BREEDING ON THE CLOCK (HERDING.breed_every_ms): one round per pen, posted once the last round's first feed at the pen
    // (pen_gate.breedRoundOf, on HQ) is that old less breed_lead_ms (the breeder's walk to the fence), with breed_pair_min penned, no tender or shepherd at the pen and no
    // dyeing begun. The round feeds as many pairs as the pen has room to raise past everything in it and every animal a
    // peer leads in (`missing`), and no more than half the penned animals: two wheat a pair (breed_manager).
    const lastRound = breedRoundOf(structure);
    const pairsBy = { half: Math.floor(inPen / 2), room: missing, wheat: Math.floor(wheat / 2) };
    const pairs = Math.min(pairsBy.half, pairsBy.room, pairsBy.wheat);
    if (!st.dyeingStarted && pairs >= 1 && inPen >= HERDING.breed_pair_min && !tender && !shepherdOf(bot, geo, selfId)
        && Date.now() - (lastRound?.at || 0) >= HERDING.breed_every_ms - HERDING.breed_lead_ms) {
        jobs.push({
            id: `breed_pen#${n}`, type: 'breed', what: 'breed_animal', need: pairs, pairs_by: pairsBy, where: { ...geo.gate },
            why: `${structure} holds ${inPen}/${flock} ${animal}; ${pairs} pair(s) fed this round; last round ${lastRound ? Math.round((Date.now() - lastRound.at) / 1000) + 's ago' : 'never'}`,
            job_type: JOB_TYPE.breed_animal, structure, scope: 'shared', claimed_by: null,
        });
    }
    if (!herdable || !herdWanted || othersTending > 0) return jobs;
    // ONE HERD AT A TIME, WITH ITS SHEPHERD'S WHEAT: one animal missing still needs a shepherd beside its bringer, so a
    // body takes a herd only with a wheat for each of them in its reach, its own and the chests'. The wheat its peers
    // already lead with is theirs.
    if (wheat < HERDING.herders) return jobs;
    jobs.push({
        id: `herd_animal#${n}`, type: 'herd', what: 'herd_animal', where: { ...geo.gate },
        why: `${structure} holds ${flock - missing}/${flock} ${animal}; ${wheat} wheat to lead with, ${leading} peer(s) leading`,
        job_type: JOB_TYPE.herd_animal, structure, scope: 'shared', claimed_by: null,
    });
    return jobs;
}

module.exports = { name: 'ranching', assess };
