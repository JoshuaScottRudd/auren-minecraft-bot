// architect_config — every tunable that shapes fleet behavior, in one place. Pure data: no logic,
// no side effects. job_board and friends import these tables and never redefine them; derived
// views (INVENTORY_WHITELIST, RESOURCE_REQUIREMENTS, craft-tier resolution) are computed FROM
// this data in job_board, not stored here. Edit a number to change what the bot does.
// FORMAT RULE: no comments between data rows — too hard to read. All per-entry notes live in the
// header block ABOVE each data structure, keyed by entry name. If you see a comment wedged between
// data rows, move it up into the header as you go.
'use strict';

// THE DEPTH FLOOR — a Y level below which the world does not exist for the fleet: every cell strictly
// under it is unroutable, undiggable, and not a collectable drop. `null` switches it off entirely; this
// is the whole toggle, no second flag.
// WHAT IT IS FOR: the deepslate layer is a different problem than stone — different tool tier, water at
// the bottom of every shaft, and dig times an order of magnitude longer. Nothing here is built for it, so
// the floor removes it from every decision at once. Deleting the CELLS rather than blacklisting the BLOCK
// NAME is deliberate: a name filter leaves the cells in the graph, so the planner still routes into the
// layer and discovers the refusal a swing later — and it would need re-listing on every stone variant
// down there. A height is one predicate no block can be an exception to.
// NOT A HARD FLOOR, and that is the wrong turn to avoid: a bot ALREADY below it — it fell, or the floor
// moved up under it — would have every route and every dig refused and be stranded permanently, a worse
// defect than the one this prevents. Each consumer suspends the floor for a body that starts below it.
// The rule is "you may not go down there", never "you may not come back".
const WORLD_DEPTH_FLOOR_Y = 0;

// SPAWN_PROTECTION_RADIUS — the half-width of the square around WORLD SPAWN inside which no block may be
// broken or placed. `0` switches the rule off entirely; this is the whole toggle, no second flag.
// IT IS THE SAME NUMBER THE SERVER RUNS ON, AND THAT IS THE POINT: `fleet_control` writes this value into
// `server.properties` as `spawn-protection` at every launch, and `perception_nodes.js/spawn_protection`
// gates every fleet decision on it. One author, two readers — the launcher cannot enforce a square the
// bots do not know about, and the bots cannot believe in a square the launcher did not set (Law 16).
// SHAPE, because it is not a distance: the game measures Chebyshev on X/Z (`max(|dx|,|dz|) <= radius`) with
// NO vertical term, so 16 is a 33x33 column from bedrock to sky, not a 16-block sphere. A circular or
// Euclidean reading under-protects the corners by six blocks and leaves shafts under spawn unguarded.
// WHY A DECLARED CONSTANT AND NOT A SENSED ONE: no packet carries it. The server never tells a client its
// spawn-protection setting, so it cannot be re-sensed the way the spawn CENTRE is — the only way the two
// sides can agree is for one number to author both.
const SPAWN_PROTECTION_RADIUS = 16;

// PERSON_CLEAR_OF_SPAWN — how far from WORLD SPAWN the test harness's person must stand before a crew is
// fetched to them (Architect 2026-09-11: *"it should be atleast 50 blocks away from world center"*).
// Chebyshev on X/Z, the same shape as the square above. A crew is teleported to the person and sites its
// base around them, so a person near the square puts the whole crew's work inside it — where every break
// and placement is refused and the server says nothing.
const PERSON_CLEAR_OF_SPAWN = 50;

// SERVER_MINECRAFT_VERSION — the protocol the fleet speaks, and the block registry that answers questions
// ABOUT blocks. It lived only in master_core's createBot call; it is here because a second reader arrived
// that must not disagree with the body, and cannot ask it. The virtual playground authors block names and
// then READS the game's own facts about them (material, harvestTools) out of this registry — the fleet's
// tool selection reads exactly those fields off a live block, so a bench pinned to a different version
// would grade the real code against a different Minecraft and report the disagreement as a bug in us.
// One authored answer, two readers (Law 16). master_core reads it here rather than restating it.
//
// THE ENV OVERRIDE EXISTS FOR THE SAME REASON THE ENDPOINT'S DOES, one paragraph down: this value is a
// fact about SOMEBODY ELSE'S SERVER, and the moment the bot runs on a machine that is not the Architect's
// it is a fact we do not know. `1.21.5` stays the authored default because it is what his world runs and
// what every bench is pinned to; the override is what lets a stranger on 1.21.1 start a bot without
// editing tracked code — an edit that would travel to every machine through git and be wrong on all but
// one. Read once, here, and nowhere else. `start_bot.js --version` is what sets it.
//
// NOT VALIDATED against a list of known versions, deliberately. The set of valid values belongs to
// minecraft-data and changes every time that package updates; a list here would be a second, staler copy
// of somebody else's fact (Law 16), and would refuse a version that actually works. A wrong value fails
// inside minecraft-data with a message that names the version and lists what it does support, which is a
// better error than any this file could author.
const SERVER_MINECRAFT_VERSION = process.env.AUREN_MINECRAFT_VERSION || '1.21.5';

// SERVER_ENDPOINT — where a body connects to reach the world. It lived as a literal `localhost:25565` in
// master_core's createBot call, twice more in the camera rig's two clients, and as a private env pair in
// the foreman: four answers to one question, which is the "parallel array kept in lockstep" this file
// exists to prevent (Law 16). It is centralised now because the endpoint is about to start CHANGING — the
// public-server plan puts the world on a rented box and the bots on a dedicated runner, and a value that
// changes with four homes changes in three of them.
// THE ENV OVERRIDE IS THE POINT, not a convenience. Pointing the fleet at another host must never require
// editing tracked code: the host differs per deployment, and an edit would travel to every machine through
// git and be wrong on all but one. `AUREN_SERVER_HOST` / `AUREN_SERVER_PORT` are read once, here, and
// nowhere else — `fleet_control` spawns bots with `{...process.env}`, so a value set in the launching
// shell reaches every body without any of them knowing it was overridden.
// THE VALUE AND THE ENV HANDLING BOTH MOVED TO `Auren_Bot/your_server.js` (2026-09-11), and this is now
// a re-export rather than a second answer. Same defaults, same overrides, same validation — what changed
// is only WHERE a person edits them. This file is the fleet's brain: nine hundred lines of reach
// distances, job tiers, blueprint names and seniority, none of which a downloader should have to open in
// order to say "my server is on a different port". `your_server.js` is that page, it sits at the top of
// the bot beside the README, and it holds nothing else.
//
// THE RE-EXPORT STAYS because the endpoint is read by name in the foreman, the camera rig and the seed
// scanner, and one of those is a shipped tool a stranger runs. Renaming the constant across them would
// buy nothing; having two files each compute `process.env.AUREN_SERVER_HOST || 'localhost'` would be the
// parallel-array fault this file exists to prevent (Law 16), and that is what this line avoids.
const SERVER_ENDPOINT = require('../your_server');

// Fleet pecking order for peer tiebreaks. Lower = elder = higher priority; a bot absent from this table
// ranks most-junior and yields to all.
// CANONICAL FLEET ROSTER (Law 16): this table IS the roster — fleet_control derives its ROSTER from these
// keys in seniority order and the camera launcher pulls the same list, so adding a bot is ONE edit here.
// A parallel array anywhere else that must be hand-kept "in lockstep" is the violation this prevents.
const BOT_SENIORITY = {
    AurenBot: 1,
    TessaBot: 2,
    IrisBot:  3,
    VesperBot: 4,
    KoaBot: 5,
    NicoBot: 6,
    EmberBot: 7,
    LumiBot: 8,
    PascalBot: 9,
    FaroBot: 10,
    RemiBot: 11,
    DanteBot: 12,
    LyraBot: 13,
    NevinBot: 14,
    VedaBot: 15,
    CorinBot: 16,
    MarnoBot: 17,
    XylarBot: 18,
    ThalonBot: 19,
    ZarekBot: 20,
};

// ── THE JOB-TYPE TABLE ────────────────────────────────────────────────────────────────────────────
// Two facts per kind of work: which ASKER it serves by default, and — only for verbs whose
// distance-from-done cannot be measured — which STAGE it occupies. It declares NO order; rank is
// composed per sweep from the two coordinates by `job_ranking`. A hand-authored order of N names states
// N(N-1)/2 pairs when the author meant a handful, so moving one name rewrites every relation it crosses.
//
//   1 · WHO ASKED    bot (the body's kit) → blueprint (a structure's shortfall) → chest (storage's
//     standing order) → busywork (so an idle bot is never idle). AUTHORED AND FIXED — nothing moves a job
//     out of its band, whatever is held waiting on it. The mechanism that once did is deleted (see
//     job_ranking): it let a CHEST job run ahead of an unfinished structure, which is the one sequence
//     this order exists to forbid, and a rule with a mechanism that can suspend it is two rules.
//   2 · HOW FAR FROM DONE    build (place it) → craft (convert it) → gather (go out for it), sorted
//     BACKWARDS. Finishing spends material already paid for; starting commits a body to a trip whose
//     value lands later. Each rung gates itself — a build needs staged material, a craft affordable
//     material — so the ladder needs no brake. And downstream work discounts everything upstream after
//     it (a better tool discounts every future gather), so finishing first upgrades the machine before
//     running more material through it.
//
// Stage is MEASURED where a recipe makes it world-dependent (a furnace is `craft` on a morning its stone
// is banked and `gather` on a morning it is not) and DECLARED where distance-from-done is a property of
// the VERB — a descent, a placement, a smelt. A declared stage asserts nothing about any other job type.
//
// MEMBER ORDER DECIDES NOTHING. It is a reading order for whoever opens this file, and the board treats
// two members landing in the same category at the same stage as EQUALS — the dispatcher draws between
// them at random. Position used to be a tiebreak, which meant real dependencies were being enforced by
// where a line sat in this table, invisibly and by accident; every one of them is a gate now. Do not
// reintroduce a relation by moving a row: moving it changes nothing, so the change would be silent AND
// ineffective. A prerequisite is usually at an earlier stage than the thing needing it, so the ladder
// still orders most relations for free; the rest are named in job_gates.
//
// PRE-BAND: not a fifth category and it takes no stages (`stage: null`). Being alive, knowing where the
// base is, and a drop about to despawn are conditions of serving ANY asker, so they cannot be sorted
// among askers and produce nothing a stage could measure. Its authored order is pure dependency.
//
// `standing:` — a standing type never stops posting; a finishable one is asked once. A finishable type
// beneath a standing one is UNREACHABLE, not patient: the standing order wins the slot back every sweep.
// Two load-time throws below enforce it (Law 13 — a guarantee whose only home is a comment is a hope).
//
// NO KEY WITHOUT A CONSUMER — dead config reads as live policy to the next author. Three consumer
// shapes, all three checked before calling a key dead: `JOB_TYPE.<key>` in an assessor; a `job_type:` or
// `supply_job_type:` cell in a table in THIS file; and `?? JOB_TYPE.<key>`, the only shape several keys
// appear in. Unguarded — an instrument for it would have to DISCOVER the keys, not carry a list.
//
// PER-ENTRY NOTES (format rule: keyed by name here, never wedged between data rows)
//   ground_salvage — THE ONLY JOB WITH A WORLD-IMPOSED EXPIRY: a drop despawns five minutes after it
//     lands, so a rank letting ordinary work go first is a rank that never fires. Whether the bot has
//     room to carry it is not expressible as a rank, so that stays a precondition in its assessor.
//   crafting_station — the table-before-the-tool relation is owned by `stationGate`, which refuses a 3×3
//     recipe with no placed table whatever it ranks. Do not re-add a rank relation for it: an order can
//     only make the table likely first, the gate makes the tool impossible first (Invariant D).
//   resource_pillaring_stock — the filler seal (STONE_PROSPECT.filler_reserve, what makes a descent
//     reversible) must be in the pocket before a stone row asks the prospect to run. That relation is
//     `job_gates.fillerGate` and is NOT this row's position: the rule used to be "no stone-consuming row
//     may be listed above this one", enforced by a load-time check on array order, and it is deleted with
//     the tiebreak. Do not re-add an ordering rule for it — a table cannot sense a pocket, so it was
//     always silent for the case that actually happens (the planks were held at post time and spent
//     before the descent). The old note read: the prospect
//     concedes for want of sealing material, the judge replans, and the dispatcher re-claims the same
//     higher row because nothing on the board changed — the supplier is never reached. Its own conceding
//     comment ("the board's own row makes it, so this clears itself") is only true while the supplier
//     outranks the consumer, which is exactly what this ordering buys. Asserted below beside the floor
//     check — the two halves of one requirement, and position is the half a comment cannot hold.
//   crafting_tool_bootstrap / crafting_tool — bootstrap is holding ZERO of a family, the spare is
//     insurance. Same verb at the same distance from done, so no coordinate separates them; what does is
//     the row's MODE, and the passive spare can never open a gather chain in front of a deadline.
//   building_headframe — the only work here with a clock the WORLD sets: the shell must stand before
//     nightfall and no later effort buys back a night outside. Selected per-requirement via
//     BUILDING_REQUIREMENTS.job_type/.supply_job_type, so ordinary buildings keep building_structure.
//   supply_seeds — safe at blueprint height ONLY because seeds feed no build. A good a build CONSUMES
//     (logs, charcoal, iron_ingot) must never carry a blueprint-level default, or a bot hoards it to its
//     dump threshold before building.
//   crafting_station_tooled — DELETED with the pocket-furnace row it ranked (see the STOCK_THRESHOLDS
//     note on `furnace`). It existed to lift "craft a furnace to carry" into the `bot` band so the fuel
//     chain did not wait behind a build; there is no such craft any more, because a furnace is half of a
//     furnace-and-chest fitting and only arrives as a blueprint's build material. Do not re-add the key
//     for the base's furnace — that one is ordered through `supply/furnace_material` in the `blueprint`
//     band, and a second key would be a second producer for one block (Law 16).
//   mining_dig_shaft — a descent, declared `gather`. It stays in `blueprint` because it is dug FOR a
//     build. It may NOT move to busywork: it FINISHES, and a finishable type under a standing one throws.
//   furnace_collect / furnace_load — both `craft`, and the pairing is the argument: collection is the
//     second half of one conversion. Calling it `gather` would rank emptying a furnace below its own
//     load, so the station never frees. Declared because a smelt has no recipe to walk — its distance
//     from done is held by the cook timer.
// PER-CATEGORY NOTES
//   preconditions — order is pure dependency: a corpse cannot eat, an unlocated base cannot be scanned
//     for wood, a wood preference decided after the pile is mixed steers nothing. The locks are one-shot
//     scans whose whole value is happening BEFORE the work they steer, and neither can churn: the
//     posting gate is "not recorded yet", which one successful run closes permanently.
//   bot — every member is a supply row with a recipe behind it, so every stage is MEASURED and none
//     should ever be declared.
//   blueprint — every declared stage is a PLACEMENT, because a build job posts only when its anchor is
//     fully staged, so by the time it exists nothing remains to gather or convert and measuring it would
//     re-derive a constant. The farm's build phase has no key of its own: the whole field posts as ONE
//     cluster job at farm_tend, which additionally requires the plot's seeds in hand (a tilled plot with
//     no seed is a second pass), so scanCluster gates on both together.
//   chest — finishable members first; the load-time check rejects any category whose members interleave.
//   busywork — EVERY MEMBER IS STANDING, AND THAT IS WHAT THE CATEGORY MEANS: work existing so an idle
//     bot is never idle never runs out, so a finishable job placed here would be permanently unreachable.
//     mining_dig_cell is ALSO the iron chain, and that is why the infinite phase belongs here rather
//     than anywhere a rank could reach it. Iron is the only ask with no deadline and no consumer that
//     runs out, so it is the one job that must never compete with work that has both — and the lowest
//     standing band is the only place that is structurally true rather than true until someone reorders
//     a list. It also gives the fleet its night shift for free: the outdoor verbs (canopy, salvage,
//     farm) are night-gated and mining is not, so after dusk the busywork band reduces to mining with no
//     clock term written anywhere. A time-conditional rank was the alternative and would have welded two
//     reasons into one verdict, leaving a held job unable to say which half held it (Law 6).
const JOB_TYPES = [
    ['preconditions', [
        { key: 'respawn_recover',        stage: null },
        { key: 'eat_food',               stage: null },
        // `exploration_seek_biome` was here and is DELETED (2026-09-10) along with the assessor that was
        // its only producer. A whitelist entry for a job nothing can post claims a permission that
        // cannot be exercised, and the daylight-gate check below would then guard a name no job carries.
        // Removing it shifts the rungs beneath it by one and changes no PAIRWISE order, which is all a
        // band comparison reads. Reasons: `assessor_registry`'s note, and bugsquashing §7.
        { key: 'base_layout_lock',       stage: null },
        { key: 'wood_preference_lock',   stage: null },
        { key: 'ground_salvage',         stage: null },
    ]],

    ['bot', [
        'crafting_station',
        'resource_pillaring_stock',
        'crafting_tool_bootstrap',
        'resource_baseline',
        'crafting_weapon',
        'crafting_defense',
        'crafting_tool',
        'crafting_flat',
    ]],

    // ── A SPECIES-EXCLUSIVE BAND, AND WHY EXCLUSIVITY LIVES HERE RATHER THAN ON THE JOB ───────────
    // The magnet filters by CATEGORY and nothing finer, so a band is the ONLY unit in which "this
    // species and not the other" can be said. A job type carrying its own species mark would be a
    // second filtering mechanism beside the magnet, and the mandate-level filter is the one the
    // intermingling ruling put there (one board, filtered at the reader) — two would have to be kept
    // in step and the board could then disagree with itself about who a job is for (Law 16).
    //
    // A HOMESTEADER-ONLY BAND ALREADY EXISTS AND NEEDS NO NEW NAME. `blueprint`, `chest` and
    // `busywork` are homesteader-only today by exactly this mechanism — the contractor's magnet does
    // not name them. Exclusivity is not a property a band declares; it is the shape of the two magnet
    // lists. So only the missing half is authored here, and an empty second band would be structure
    // with no member to justify it.
    //
    // POSITION IS THE RULING IT ENCODES: below `bot`, so a contractor equips itself before it builds
    // anything; above `blueprint`, so its own shelter outranks the estate it will never work on.
    ['contractor', [
        // `stage: 'build'` is DECLARED rather than measured — an undeclared stage sends the job through
        // measureStage's what/need walk, and a build job carries neither (Law 13 throw at the first sweep).
        { key: 'building_contractor_house', stage: 'build' },
    ]],

    ['blueprint', [
        { key: 'building_headframe',        stage: 'build' },
        'building_headframe_supply',
        'supply_seeds',
        { key: 'farm_tend',                 stage: 'build' },
        { key: 'building_structure',        stage: 'build' },
        { key: 'light_base',                stage: 'build' },
        { key: 'mining_dig_shaft',          stage: 'gather' },
    ]],

    ['chest', [
        { key: 'furnace_collect',        stage: 'craft' },
        { key: 'furnace_load',           stage: 'craft' },
        { key: 'resource_standing_stock', standing: true },
        { key: 'resource_chest_restock',  standing: true },
    ]],

    ['busywork', [
        { key: 'mining_dig_cell', stage: 'gather', standing: true },
        { key: 'clear_canopy',    stage: 'gather', standing: true },
    ]],
];

// Index IS the order, so this array is the only place the ladder's direction exists — reversing the
// fleet's whole scheduling policy is reversing it.
const STAGES = Object.freeze(['build', 'craft', 'gather']);
const STAGE_INDEX = Object.freeze(Object.fromEntries(STAGES.map((s, i) => [s, i])));

// JOB_TYPE maps a key to ITSELF, not to a number. A numeric identity is what the night gate and the
// magnet filter used to key on, and under a composed rank many job types share a slot — so a rank-keyed
// identity stops matching silently, and a night gate that never closes works surface jobs until dawn
// with nothing to say why. Keeping the lookup rather than letting assessors write bare strings preserves
// the load-time typo catch: a misspelt member reads `undefined` and supplyJob throws.
const JOB_TYPE = {};
const JOB_CATEGORY_OF = {};   // key → the asker it serves; authored, and nothing moves a job out of it
const JOB_STAGE_OF = {};      // key → declared stage; ABSENT means "measure it"; null means pre-band
const JOB_STANDING = new Set();
const CATEGORY_NAMES = Object.freeze(JOB_TYPES.map(([category]) => category));
const PRE_BAND = CATEGORY_NAMES[0];
const CATEGORY_INDEX = Object.freeze(Object.fromEntries(CATEGORY_NAMES.map((c, i) => [c, i])));
// The pre-band's members are an ORDERED LIST OF BANDS, not one band with a tiebreak inside it — a dead
// bot must respawn before it eats, and those two are not interchangeable the way two equally-good
// gather jobs are. Same mechanism as CATEGORY_NAMES applied one level in, which is why it is a list
// position and not a number: both name a place in an authored sequence, neither is a weight.
const PRE_BAND_MEMBERS = Object.freeze(JOB_TYPES[0][1].map(m => (typeof m === 'string' ? m : m.key)));

// NO TIEBREAK IS COMPUTED HERE AND NONE MAY BE ADDED. A job's position is (band, rung) and nothing
// else; two jobs that agree on both are EQUAL, and the dispatcher picks between them at random rather
// than by any third fact. The deleted mechanism was a running counter over these arrays, so a job's
// position in the file silently decided fleet scheduling: it looked like data and behaved like policy,
// it enforced real dependencies invisibly (a pickaxe-less bot was kept off rock by ARRAY ORDER), and
// every new job type had to be inserted at a position whose consequences nothing stated. Dependencies
// are gates now — a gate holds a job and says why (Law 6); an ordinal holds it and says nothing.
for (const [category, members] of JOB_TYPES) {
    for (const member of members) {
        const key    = typeof member === 'string' ? member : member.key;
        const stage  = typeof member === 'string' ? undefined : member.stage;
        const stands = typeof member === 'string' ? false : member.standing === true;
        if (JOB_TYPE[key] !== undefined) {
            throw new Error(`CODING VIOLATION (Law 13): JOB_TYPES lists "${key}" twice — one job type, one identity (Law 16).`);
        }
        if (stage !== undefined && stage !== null && !STAGES.includes(stage)) {
            throw new Error(`CODING VIOLATION (Law 13): JOB_TYPES member "${key}" declares stage '${stage}', `
                + `which is not one of ${STAGES.join('/')}.`);
        }
        // Mixing the band with the ladder fails SILENTLY: a pre-band member carrying a stage composes
        // into a slot beneath the askers it is a precondition of, and a categorised member with no stage
        // has no slot at all. Both directions throw here rather than at the first sweep.
        if (category === PRE_BAND && stage !== null) {
            throw new Error(`CODING VIOLATION (Law 13): pre-band member "${key}" must declare \`stage: null\` — `
                + 'the pre-band ranks conditions of being able to serve any asker, and a stage is meaningless for work that produces nothing.');
        }
        if (category !== PRE_BAND && stage === null) {
            throw new Error(`CODING VIOLATION (Law 13): "${key}" is in category '${category}' and declares \`stage: null\`, `
                + 'which only the pre-band may do. Give it a stage, or omit `stage` to have the board measure it.');
        }
        JOB_TYPE[key]        = key;
        JOB_CATEGORY_OF[key] = category;
        if (stage !== undefined) JOB_STAGE_OF[key] = stage;
        if (stands) JOB_STANDING.add(key);
    }
}

// THE STANDING/FINISHABLE RULE, now ONE throw where it used to be two. The deleted half asserted that a
// finishable member must be listed before any standing member INSIDE its own category — true only while
// list position broke ties, because the finishable job then lost its own slot every sweep. Ties are
// resolved at random now, so a finishable job sharing a (band, rung) with a standing one is picked
// roughly half the time and cannot starve. The half that survives is not about position at all: bands
// are strictly ordered, so a finishable job in a band BELOW one holding unconditional standing work is
// unreachable no matter what else changes.
const _standingCategoryFloor = Math.min(
    ...[...JOB_STANDING].map(key => CATEGORY_INDEX[JOB_CATEGORY_OF[key]])
);
for (const key of Object.keys(JOB_TYPE)) {
    if (JOB_STANDING.has(key) || JOB_CATEGORY_OF[key] === PRE_BAND) continue;
    if (CATEGORY_INDEX[JOB_CATEGORY_OF[key]] > _standingCategoryFloor) {
        throw new Error(`CODING VIOLATION (Law 13): finishable job type "${key}" sits in category `
            + `'${JOB_CATEGORY_OF[key]}', below the highest category holding standing work `
            + `('${CATEGORY_NAMES[_standingCategoryFloor]}'). A standing order never stops posting, so this job `
            + 'is unreachable at every stage rather than merely patient — move it up, or declare it `standing: true`.');
    }
}
// NO SLOT ARITHMETIC, NO COMPOSED INTEGER, NO DECODER. A job's position is the pair (band, rung), held as
// the two names it was measured as — `asker` and `stage`, stamped on the job itself — and job_ranking
// compares those directly. The integer that used to carry them was packed here and unpacked in four
// consumers, and packing is what made the model unreadable at the point of use: a reader holding 4001
// could not see a band, a rung or a tie in it, and the arithmetic was the only thing that knew which
// digits were which. `dispatchCategoryOf` existed to unpack it and had NO CALLER anywhere in the fleet —
// a decoder kept alive for a consumer that never existed (Law 16).
//
// ORDER NOW LIVES IN EXACTLY ONE PLACE: `job_ranking.selectBand`. It walks CATEGORY_NAMES, then STAGES,
// and returns the first non-empty group — so the ordering IS the two authored lists being read in order,
// with nothing composed, nothing tuned, and no third fact able to enter. Everything that survives that
// walk is equal, and the dispatcher picks among equals at random.

// ── DAY / NIGHT GATING ─────────────────────────────────────────────────────────────────────────────
// Vanilla clock: 0 = dawn, 12000 = dusk, 24000 = next dawn; surface monsters spawn from ~13000. The gate
// closes at DUSK rather than first-spawn so a bot is not caught in the open by the difference. It is a
// POSTING gate — an already-claimed job runs to completion (Law 4: it declines to offer, never preempts).
const NIGHT_STARTS_AT = 12000;
const NIGHT_ENDS_AT   = 23000;

// PEACEFUL HAS NO NIGHT (Architect 2026-08-31: *"while the game is on peaceful there is no night gate, the
// bots can keep working, no monsters."*).
//
// The gate's whole subject is HAZARD, not darkness. Every line of reasoning attached to it — "a bot caught
// in the open at dusk", "a body without walls at dusk is exposed", the night-gather exemption, the
// drop-collector's night sweep — is about what spawns after 13000, and on peaceful nothing does. So the
// dark on peaceful is a cosmetic fact, and holding half the job board for it costs the fleet an entire
// shift per day in exchange for protection against a threat the world cannot produce.
//
// ANSWERED BY THE GAME, NOT BY OUR LAUNCHER. `fleet_control` does author `difficulty: peaceful` in the
// server properties, and reading it from there would be reading our own belief back (Law 26 — read the
// machine's own output). mineflayer carries the server's answer on `bot.game.difficulty`, set from the
// `difficulty` packet the server sends on join and again whenever it changes, so a difficulty flipped
// live by an operator is picked up with no restart and no second place to update.
//
// UNKNOWN IS NOT PEACEFUL. Before the packet lands the field is undefined, and that answers NO here —
// default-stopped (Law 13), because the failure this guards is a bot outdoors in the dark with monsters.
// Note that mineflayer's own login handler is `if (packet.difficulty)`, and peaceful is 0, so the login
// packet can never set it; the standalone `difficulty` packet is what populates the field, and it does so
// unconditionally.
function isPeacefulWorld() {
    const d = global.bot && global.bot.game ? global.bot.game.difficulty : null;
    return d === 'peaceful';
}

// Read raw rather than through a perception node — forwarding one unchanged field is a pathway with
// nothing on it (Law 16). Null before the first server tick is treated as DAY: declining every surface
// job on a missing clock idles the whole fleet at spawn, and a bot at dawn with no clock is not in danger.
//
// The peaceful check sits HERE rather than in each of the four callers, because every one of them asks
// this function the same question — "is it unsafe outside right now" — and a fifth caller written later
// would have to remember the exemption. One place answers it, so none of them can disagree (Law 16).
function isNightTime() {
    const tod = global.bot && global.bot.time ? global.bot.time.timeOfDay : null;
    if (tod == null) return false;
    if (isPeacefulWorld()) return false;
    return tod >= NIGHT_STARTS_AT && tod < NIGHT_ENDS_AT;
}

// NOT a list of surface verbs — a LINE: outdoor work stops at dusk, and the headframe shell does not,
// because it is the only job carrying a clock the world sets. Everything else waits for dawn at no cost
// but time.
//
// THE TEST FOR MEMBERSHIP IS WHERE THE WORK HAPPENS, NEVER WHAT THE JOB IS ABOUT — the one way this list
// gets re-derived wrongly. A job whose block stands inside the shell belongs to the night. Reading a
// job's SUBJECT as outdoor work gates a bot away from indoor infrastructure it needs, at night, when
// nothing else is available to it.
const DAYLIGHT_ONLY_JOBS = new Set([
    'resource_baseline',        // surface gathering — logs and the like (a build's own gather)
    'resource_standing_stock',  // the same work for a standing shelf level, in a weaker band
    'supply_seeds',
    'farm_tend',
    'clear_canopy',
    'ground_salvage',           // outdoor walk to a drop
    'building_structure',       // every build EXCEPT the headframe, which is why the type is named here
    // Raised on open ground like any other structure. THE SHELTER IT PROVIDES IS NOT AN ARGUMENT FOR
    // BUILDING IT AT NIGHT — that reads the job's SUBJECT instead of where the work happens, which is the
    // one way this list gets re-derived wrongly. A body without walls at dusk is exposed for the whole
    // build either way; only the headframe's deadline earns an exemption, and this carries none.
    'building_contractor_house',
    'light_base',               // torching the yard
    // `exploration_seek_biome` was the third entry and went with its job type (2026-09-10). It was the
    // only member here that existed for TRAVEL rather than for exposed work, and nothing travels for a
    // build site any more — a homesteader in the wrong biome stops instead (Law 13).
]);
// A gate keyed on a name no job carries never closes, and it fails SILENTLY — surface jobs run all night
// and nothing says why. Law 13: a coding violation, so it throws at load and a rename catches for free.
for (const job of DAYLIGHT_ONLY_JOBS) {
    if (JOB_TYPE[job] === undefined) {
        throw new Error(`CODING VIOLATION (Law 13): DAYLIGHT_ONLY_JOBS names "${job}", which is not a job type in JOB_TYPES. The night gate would never match it.`);
    }
}

// Keyed on the job's KIND. The wrong turns, both taken: `job.id` is per-instance and `job.type` is the
// manager routing token, so a gate on either looks correct while filtering almost nothing; and a gate on
// the RANK worked only while a rank was unique per job type, which a composed rank ended.
function isDaylightOnlyJob(job) {
    return DAYLIGHT_ONLY_JOBS.has(job.job_type);
}

// The type list cannot do this alone, because GATHERING IS NOT A JOB TYPE — it is a STEP many job types
// take when they run short, dispatched from inside several of them alike, so a type list can only chase
// it. A chest-restock job is chest-to-chest inside the base until storage is dry, at which point the
// same job walks a bot outside to fell a tree. Blacklisting those types instead would delete the
// legitimate night shift: crafting and chest work are exactly what a bot should do after dusk.
//
// PREDICT THE STEP, DO NOT POLICE IT. A refusal placed at the seam the bot leaves through can decline the
// trip but cannot stop the order being re-made, so the board re-posts every sweep and the pair loops
// until a judge kills the signal — two owners of one decision (Invariant D). The board instead walks each
// order back to its LEAVES the way the fulfiller will and refuses to post one whose remaining roots need
// a route that is shut. A step never reached needs no gate at it.
//
// The shell keeps its exemption at the step too, or the exemption above is hollow: a headframe supply job
// claimable at night but unable to gather at night is a job that cannot finish at night.
const NIGHT_GATHER_EXEMPT_JOBS = new Set([
    'building_headframe_supply',
]);
for (const job of NIGHT_GATHER_EXEMPT_JOBS) {
    if (JOB_TYPE[job] === undefined) {
        throw new Error(`CODING VIOLATION (Law 13): NIGHT_GATHER_EXEMPT_JOBS names "${job}", which is not a job type in JOB_TYPES. The exemption would never match.`);
    }
}

// May this job reach outside for material right now? Keyed on the job's KIND for the same reason the
// night gate above is (see the wrong-turn note there). An unrecognised kind answers NO at night —
// default-stopped (Law 13), because the failure it guards is a bot outdoors in the dark.
function mayGatherOutdoors(job) {
    if (!isNightTime()) return true;
    return NIGHT_GATHER_EXEMPT_JOBS.has(job.job_type);
}

// The boardroom-chair field the wood preference travels in, named here because one writer and one reader
// holding the same literal in two files is how the two silently stop agreeing (Law 7 / Law 16). It rides
// the CHAIR because one bot decides this for the whole fleet, so it needs a channel the overseer
// broadcasts; the chair already carries per-bot facts, every writer read-modify-writes it, and it has
// exactly one owner so no merge conflict can arise (Invariant D). Not the building conference — three
// consumers iterate that room's keys expecting buildings.
const WOOD_PREFERENCE_CHAIR_FIELD = 'wood_preference';

// Build steps in order (order field = build priority). The type tokens are shared with job_board's
// assessors/building and defined here so BUILDING_REQUIREMENTS can embed them without a circular import.
const TYPE_COORDINATES        = 'coordinates';
const TYPE_BLUEPRINT_PASTED   = 'blueprint_pasted';
const TYPE_STRUCTURE_COMPLETE = 'structure_complete';

// A `condition` token gates a requirement: assessors/building skips it (never dispatches, never lets it
// become the first-unsatisfied) until the named condition holds (job_board.conditionMet). No condition
// token is live today — the one requirement that ever used one was scrapped once wild-tree availability
// removed the need for a cultivated plot. The gate mechanism stays for the next conditioned requirement;
// the entries below are unconditional.
// `job_type` / `supply_job_type` name a JOB_TYPES key and are what makes a building UNIQUE on the board.
// Omit both and a building takes the defaults — building_structure for the build, resource_chest_restock
// for its material order — which is where every building but this one belongs.
// The headframe overrides both because it is the only structure with a deadline; see the headframe band
// in the table above for why a deadline is the thing that earns a rank of its own.
const BUILDING_REQUIREMENTS = [
    { field: 'headframe', type: TYPE_COORDINATES,        order: 0 },
    { field: 'headframe', type: TYPE_BLUEPRINT_PASTED,   order: 1 },
    { field: 'headframe', type: TYPE_STRUCTURE_COMPLETE, order: 2, execute_key: 'headframe_execute',
      job_type: 'building_headframe', supply_job_type: 'building_headframe_supply' },
];

// ── WHICH STRUCTURES A PERSON MAY ASK FOR: AN AUTHORED WHITELIST ─────────────────────────────────────
// The one list of buildings a human can request by name. Everything about a structure that is derivable
// lives in a table already — the blueprint registry knows the shape, BUILDING_REQUIREMENTS knows the
// ladder — and this list is here because the question it answers is derivable from NEITHER.
//
// THE FACT IT CARRIES IS ATTACHMENT, AND NOTHING COMPUTES IT. Most structures in the registry are not
// free-standing: a mineshaft joins a headframe in a specific way, at a specific place, in a specific
// order. "Can this be raised on its own, starting from nothing, because somebody asked for it" is a
// property of how a structure relates to the others, and no table in this tree records relations between
// structures. So it is AUTHORED, deliberately and with a named owner (Law 27: where no constitution is
// available the regulation is the correct form — it owes a name, a stated rule, and a truthful report;
// this is the name and the rule).
//
// WHY NOT DERIVE IT FROM BUILDING_REQUIREMENTS. That was proposed and is wrong, and the way it is wrong is
// worth keeping: a ladder is NECESSARY for raising a structure and not SUFFICIENT for offering one. An
// attached structure will eventually get its own requirement rows — that is what "its own pass" means —
// and on that day a derived list would silently begin promising it standalone, which is exactly the
// over-promise this list exists to end, arriving through the mechanism that was supposed to prevent it.
// The two facts are independent, so they are two lists.
//
// ADDING ONE IS A DESIGN ACT, NOT AN EDIT. A structure joins this list only after a pass that decides how
// it is sited relative to whatever it attaches to, what it requires, and what "complete" means for it.
// The list being short is the honest state of that work, not an oversight.
//
// A NAME HERE MUST ALSO HAVE REQUIREMENT ROWS ABOVE — this list says a person may ASK, the ladder says the
// crew can BUILD, and a name with only the first is a promise with nothing behind it. Asserted at load in
// requestable_catalogue rather than trusted (Law 13: a mismatch between two authored tables is a coding
// violation, and the throw is what makes this comment unable to go quietly false).
const REQUESTABLE_STRUCTURES = ['headframe'];

// Every stock the fleet maintains, in bot pockets or in shared storage. Fields:
//   holder            'bot' | 'storage'   WHICH LAYER holds it — never which chest.
//                     'bot'     — this body's own kit. Measured on the pocket, dumped from the pocket.
//                     'storage' — the fleet's chest system as ONE logistical pool. Measured across every
//                                 registered chest (inventory_lens.forChestRequest), filled by depositing
//                                 into ANY chest, spent by withdrawing from ANY chest.
//                     A REQUEST IS FLEET-WIDE AND IS NOT ADDRESSED TO A CHEST. The holder used to be
//                     `{ blueprint: 'headframe', chest: 1 }` with a `role` of 'requester' or 'buffer',
//                     and three role-only rows declared chests 2-4 as buffers. Every one of those names
//                     is deleted: a chest is a chest, requests are placed into any chest and surplus is
//                     dumped into any chest. WHY THE NAMES WERE ALREADY A LIE: the deficit that opens
//                     one of these rows has been measured across every chest for some time, so a row
//                     naming chest 1 was ALREADY answered by material sitting in chest 3 — the address
//                     decided only where a delivery walked, never whether it was needed, and the
//                     buffer→requester courier that existed to reconcile the two could by construction
//                     never fire (if a chest held the stock, the deficit was already closed). WHAT IT
//                     BREAKS IF RE-ADDED: the base now carries ONE chest on headframe anchor 0 beside
//                     its crafting table and furnace, so a role split has nothing to split — whichever
//                     role that single chest were assigned, every read of the other role would find
//                     nothing and the dump or the request would silently stop working.
//   deficit_below     THE POSTING TRIGGER: a job posts while the holding is under this number, and the
//                     order closes when it reaches it. Omit for a hold-only row (held, never restocked
//                     toward). It is the ONLY target in this table.
//   mode              'active' | 'passive'   REQUIRED on every row that declares a `deficit_below` (see below)
//   dump_threshold    THE DUMP TRIGGER, and NOTHING ELSE: nothing is dumped until the holding exceeds it.
//                     NOT a goal and never readable as one — that ambiguity is exactly why the two fields
//                     were renamed off `min`/`keep`. Overshoot between the two numbers is expected and
//                     costs nothing: one torch craft yields four, so a bot at 11 lands on 15, which is
//                     satisfied and nowhere near dumping.
//   kind:'tool'       family token; the deficit is crafted at the highest tier the bot can make
//   min_tier          a tool family's FLOOR: never craft below this tier even when a lower one is
//                     makeable (sword: 'stone'). Absent → wooden, the resolver's own floor.
//   gate:[items]      an any-of presence threshold across pocket + chests, checked by job_gates
//   gate_min          require at least N of the gate item(s) before posting (default 1). ONLY EARNS ITS
//                     PLACE AS A *BATCH* THRESHOLD — a passive row already refuses to post unless one
//                     craft is affordable, so a gate naming an ingredient of its own recipe restates the
//                     mode and is deleted rather than carried.
//   requires_station  the job needs that station to exist in the world
//   job_type:'<key>'  override which job type this row posts as, and therefore which ASKER it is sorted
//                     under: a craftable/gather row defaults to crafting_flat / resource_baseline, a
//                     `holder:'storage'` row defaults to resource_chest_restock. GUARDRAIL: only give a
//                     storage row a BLUEPRINT-category job type if NO build consumes its good
//                     (wheat_seeds ok; logs/charcoal/iron_ingot never) — else the bot fills storage to
//                     target before building instead of building with what it holds.
//   (`role:` is REJECTED at load — the integrity loop throws on it. See the `holder` entry above.)
//
// MODE — intrinsic and permanent, never a phase a row passes through:
//   ACTIVE   the shortfall DRIVES ACQUISITION down its whole chain — gather, mine or smelt recursively.
//   PASSIVE  the shortfall is FILLED FROM WHAT EXISTS and never opens a chain. The row states an
//            appetite; something else's work feeds it.
// GATING IS AN OVERLAY, NOT A THIRD MODE: a gate decides WHEN a row is visible, the mode decides WHAT
// the fleet does about it. Nothing is ever promoted from passive to active by a gate opening.
// DECLARED, NEVER INFERRED (Law 13). Mode was once implicit in a row's SHAPE — a raw good behaved
// passively, a craftable one drove its inputs — so an edit meaning something else entirely could change
// it: deleting a `logs` bot row for pocket hygiene silently turned the whole charcoal line passive, two
// files from where anyone was looking. Mode is also what makes the BOT category safe above the build:
// the ladder keeps a passive row cheap, the mode stops it opening a trip at all.
//
// `dump_threshold` — NOT `target`, and the name is what it does:
//   BEING A holder:'bot' ROW AT ALL IS THE WHITELIST. INVENTORY_WHITELIST derives from exactly these
//   rows and computeExcess treats anything no row covers as 100% excess — so deleting a row does not
//   make an item unmanaged, it makes it dump ENTIRELY. That is how saplings and bread hold zero with no
//   special case, and it is the complete answer to "stop carrying X".
//   `dump_threshold` is what SURVIVES A DUMP; everything above it goes into a chest. IT IS NOT A FILL-TO
//   CEILING FOR ANY ROW — craftable rows used to read it forward as one ("hold N" implies "make up to
//   N"), which made every crafted row haul to its dump line and made the smelt batch twice the size of
//   the shortfall that opened it. Every goal in this file is `deficit_below`. A GROUP TOKEN spends ONE
//   allowance across all its members, never one each.
//
// DUMP THRESHOLDS ARE TUNED TOWARD "DUMP EVERYTHING VERY OFTEN": the tools, the two portable stations, a pillaring
// stack, a wall-repair stack of cobblestone, nothing else. THE LINE IS "DOES THE VERB IN PROGRESS
// CONSUME IT", never "is it bulk" — cobblestone reads as bulk and is not, since a miner seals a shaft
// breach with it and a dump threshold of zero strands it beside a wall it cannot close. Keeping zero of true bulk
// also drains the peer-pocket hole: accessibleMaterialPool sums the bot's own pocket plus every chest,
// so material in a PEER's pocket is invisible to the fleet, and a zero dump threshold puts it in a chest instead.
//
// Per-item notes (format rule: keyed by name here, never wedged between data rows):
//   ROW ORDER DECIDES NOTHING, INCLUDING THE BOOTSTRAP. It once did — the dispatcher's sort was stable,
//     so rows at one rank kept this table's order and pickaxe-first was the whole guarantee. Equals are
//     drawn at random now, and the guarantee survives because it was never really about order: the
//     pickaxe is the only tool family with no stone floor, so it resolves to a WOODEN pickaxe whose roots
//     are logs, while every floored family resolves to a STONE tool whose roots include cobblestone —
//     and `job_gates.toolGate` holds any job whose roots need rock while no pickaxe is carried. The axe
//     is therefore held until the pickaxe exists, by a gate that says so, rather than merely losing a
//     coin flip it was never told it was in. The failure the old order was avoiding: axe-first posts a
//     stone_axe shortfall, dispatches a prospect, and idles it for want of the pickaxe — a wasted cycle,
//     self-correcting and therefore silent.
//   pickaxe — THE ONLY ROW THAT KEEPS TWO, a fallback ladder rather than a preference. A broken sword
//     falls back to the axe by combat_utils' own scoring; a broken axe falls back to the fist. A pickaxe
//     that breaks at the bottom of a shaft has NO next rung — nothing else mines stone — so the spare is
//     what stops it stranding the chain everything else is gated on. Durability is tracked nowhere, so a
//     spare is the only guard: at deficit_below 1 the replacement posts once the last one has already shattered.
//   axe / sword — EVERY TOOL BUT THE PICKAXE FLOORS AT STONE (`min_tier`). A wooden one is a craft spent
//     on a tool replaced the moment the first shaft lands, costing the same planks the pillaring stock
//     and the crafting table draw on; the floor defers the craft, it does not forbid the work. The floor
//     is spent in resolveCraftTier rather than as a `gate` because `gate` is read ONLY on the bot-holder
//     branch of assessors/supply — a gate here would leave the chest's spare-sword row still making
//     wooden ones, while the resolver covers both branches (Law 16).
//   sword — the fleet's PRIMARY weapon; the axe IS its spare, by combat_utils' ranking, so nothing here
//     tracks durability. `crafting_weapon` gives it its own key, which no longer buys it a position (it
//     is an equal of the pickaxe and axe it shares a band and rung with) but is still what lets a GATE
//     name it alone — a job type is the only handle a gate has, and a weapon is exactly the kind of row
//     that will eventually need one.
//   tools (group row) — the three rows above carry kind:'tool', which INVENTORY_WHITELIST filters out, so
//     without this group row every tool in the pocket would be uncovered — and uncovered means 100% excess.
//   shield — rung-2 defense (block a hit with no retreat). PASSIVE, and the mode is what protects it: its
//     one metal input is a furnace product, and unheld the plan decomposes shield→raw_iron and dead-ends
//     STUCK, because iron_ingot is not craftable in hand and nothing names a missing material to explain
//     why. Passive defers it to the furnace chain already smelting iron for the tool tiers.
//   crafting_table — dump_threshold 1 for a circular dependency, not convenience: a bot that dumps its table cannot
//     craft the table back without one.
//   furnace — HAS NO ROW, AND THE ABSENCE IS THE DESIGN. It used to be the second portable station: a
//     bot carried one, set it down in a field, registered it, smelted and picked it back up. That is
//     deleted along with the `place` action, the field tag and the collect-time recovery, because a
//     furnace is HALF OF A TWO-PART FITTING and the other half is a chest. A cook is sized for the whole
//     fleet's demand (two bots wanting 12 torches each = 6 charcoal in ONE load), so whoever empties the
//     furnace is usually not whoever asked for the output; output cannot go back into the furnace, so the
//     emptier must be able to keep its own share and BANK the rest where the asker withdraws it. A
//     furnace on open ground has no chest beside it, so every batch it cooks is unshareable by
//     construction — which is why the only furnace this fleet uses stands in a placed blueprint that also
//     carries a chest (headframe anchor 0: chest, crafting table, furnace), and why furnace_executor
//     THROWS when dispatched to empty one with no chest registered anywhere.
//     WHERE A FURNACE COMES FROM NOW: the blueprint's own voxel, ordered as build material through
//     `supply/furnace_material` like any other block. A standing row here would be a second producer
//     asking for the same block on a different errand (Law 16), and the errand it ran ended on open
//     ground. WHAT THIS COSTS, stated so it is not re-added as an obvious fix: charcoal — and therefore
//     torches — is no longer reachable by a bot with no base. That is the intended trade; the fuel chain
//     is contingent on a shell standing, and the shell is the earliest deadline the fleet has.
//   crafting_table KEEPS ITS ROW, and the asymmetry is not an oversight: a craft is instantaneous and
//     fully consumed by the body performing it, so a table set down and taken back up hands nothing to
//     anybody. A cook outlives the visit and belongs to the fleet. Portability follows the batch, not the
//     block (`stationUsable` encodes the same split — see station_registry).
//   torch — NO `requires_station: 'furnace'`, and its absence is load-bearing: the torch RECIPE needs a
//     crafting table, and the furnace only makes CHARCOAL, which is one of two fuels this row accepts —
//     COAL comes straight out of the shaft. A furnace prerequisite here refuses a craft the fleet can
//     already perform, and it closes a loop no single symptom names: no torch → the shaft is unlit → mobs
//     spawn in it → bots die in the dark → every death drops the pocket → the material for the furnace
//     never accumulates. NO MATERIAL GATE EITHER: one craft makes exactly four and `deficit_below` is above that, so
//     the row stands down by construction; a fuel floor sized against `dump_threshold` (the ceiling) instead of
//     `deficit_below` (the floor) leaves the row one unit from opening, which is indistinguishable in a trace from
//     a gate that is broken. Everything in the chain works on PULL and material is never withheld from a
//     craft that can use it — a partial is the crafting system's to compute and report honestly (Law 25),
//     not the board's to prevent by refusing to post.
//     THE FLOOR IS A DESCENT'S WORTH, NOT A CRAFT'S WORTH. mining_manager gates every descent on THIS
//     number (Law 16 — one torch floor, not two), so a floor of one craft authorises a descent the bot
//     cannot light its way out of. `dump_threshold` is high for the overworld auto-torch reflex, which burns torches
//     faster than mining alone; a torch is not bulk, it is what makes a shaft workable.
//   planks — THE PILLARING STOCK, the only bulk a pocket holds: a REORDER POINT, not a hoard. The floor
//     triggers the return-for-more trip, the ceiling is what the bot comes home with, and the ceiling
//     stays small because every unit above the floor is a unit lying next to a corpse when the bot dies.
//     THE FLOOR IS SET BY THE PROSPECT'S SEAL, not by pillaring — the assertion below this table binds it
//     to STONE_PROSPECT.filler_reserve, because a bot above its own floor but under the seal blocks the
//     whole stone chain while reading as satisfied. NO `gate: ['logs']`: it meant "post planks only if
//     logs are already in the pocket", which was a PULL check on the one row that has to PUSH — once logs
//     went pull-only nothing gathers them, so the gate never opens and nothing ever asks.
//     See scaffold_block in fragment_utils for the matching placement order — the threshold and the order are two
//     halves of one ruling and re-tuning either alone re-opens the gap dirt used to fill.
//   stick — hold-only, no `deficit_below`: sticks are never gathered toward, they fall out of the craft cascade on
//     the way to a tool. The row exists only so leftovers are not classed as excess and dumped.
//   logs — HAS NO BOT ROW. Pull-only, so any logs in the pocket are 100% excess and leave on the next
//     dump. What gathers wood is the storage logs row, which before that chest exists
//     stands in against the bot's own pocket (the pocket-stand-in block in `assessors/supply`).
//   cobblestone — dump_threshold 20, NOT zero, and it is not surplus: cobblestone is the first entry of
//     structural_fill, which seals a shaft wall breach, so a miner that dumped its last cobble cannot
//     repair the tunnel it is standing in — and sealing is non-deferrable, so the segment can neither
//     finish nor stand down. ACTIVE so the shortfall DRIVES acquisition through the stone prospect; while
//     it was hold-only the only producer of cobblestone was the headframe's descent, which cannot post
//     until a base is sited, and everything past cobblestone inherited that wait. `deficit_below` matches the
//     prospect's fixed yield so a satisfied row and a completed trip are the same number.
//   raw_iron — KEEP 0 MEANS "REFINE ALL OF IT", not "we don't want it". Nothing spends raw iron in hand:
//     furnace_executor FETCHES its input from storage, so the pocket is pure transport. Not the
//     cobblestone trap, because the line is whether the VERB IN PROGRESS consumes it — and every
//     raw_iron measurement on this chain reads pocket AND chests, so banking it cannot hide it. The row
//     is INERT (no `deficit_below`, and keep 0 dumps exactly as no row would) and kept anyway, because the config
//     is where a reader looks to find out what the fleet does with a material and an absence answers
//     nothing. Do not tune it expecting effect — the iron_ingot storage row's `dump_threshold` is that knob.
//   wheat / bread — bots hold ZERO food; bread is SHARED stock in a chest, baked from wheat
//     and delivered there, and a hungry bot eats straight from the chest (eat_executor's storage-withdraw
//     path is the PRIMARY eat route). One baker holding its own loaves cannot feed a peer. wheat stays
//     holder:'bot' at dump_threshold 0 — the ROW stays because it is the crafter's declared input and deleting it
//     would say the fleet does not want wheat, but a pocket is the wrong place to accumulate it, since
//     one bot's wheat cannot feed another bot's oven. Scarcity is enforced by `farm_items` in
//     fragment_utils, which marks wheat a farm-chain product so supply_manager PARTIAL-bakes and never
//     tries to GATHER a crop no wild scan can find (read farm_items before touching either row).
//   iron_ingot — the one furnace output with a row, and it carries neither `gate` nor `requires_station`
//     because assessors/supply skips any row with a furnace input before reaching those checks;
//     assessors/furnace owns it and asks its own questions. Carrying the fields anyway is worse than
//     useless — they read as the live prerequisite to anyone reasoning about the chain.
//     It is PASSIVE: its input is underground and an iron ask is a multi-hour commitment, so it converts
//     whatever the standing dig brings up rather than commissioning a descent.
//     CHARCOAL, THE OTHER FURNACE OUTPUT, HAS NO ROW — see the note where it was deleted. Nothing wants a
//     standing pile of charcoal; what wants it is whichever order is short of it this sweep, and that
//     quantity is derived, not authored. Its demand reaches assessors/furnace through the board's
//     published `materials_wanted` instead.
//   iron_ingot — min AND keep equal, deliberately. On a storage row `dump_threshold` is both the fill-to ceiling
//     and the number the mining pull derives from, so ONE number decides how much iron the fleet holds
//     and how much raw iron it sends the shaft down for; equal makes the ask literal. Equal deficit_below and dump_threshold
//     normally thrashes and does not here because in-flight smelt batches are ADDED to `have` before the
//     deficit test — that in-flight term is the hysteresis, and without it these two would have to be split.
//   wheat_seeds — SEEK TWO, HOLD THIRTY-TWO, COMPOST THE REST. A high seek floor is a hazard, not merely
//     slower: grass drops seeds at a low rate, so seeking more than a couple is a long wandering search
//     with no fixed endpoint that can carry a bot far from base into the dark. Two is enough because the
//     FARM pays, not the grass — mature wheat drops seeds guaranteed, so two is a seed crystal and the
//     field compounds from the first harvest. `dump_threshold` is the compost handoff: the surplus lands in a
//     chest where the composter's standing request pulls it back out. No new pathway.
//   saplings — dump_threshold 0 sheds them from the pocket, NOT because they are worthless: the composter's
//     standing request drains them out of whatever chest they land in. Where an item rests stops
//     mattering once something asks for it.
//   bone_meal — CRAFTED, NEVER SOUGHT, and that takes two mechanisms because a gate decides whether a row
//     POSTS, not what the order ASKS FOR: `bone` is a hunt_items MARKER (a drop off a corpse no block
//     scan can find), which makes the SEEK impossible, and `passive` makes the POSTING wait. Different
//     failures, both live. Its second source, the composter, is not a redundant route — the craft
//     converts a mob drop, the composter converts plant waste, and the row asks for the RESULT.
//   sword (storage) — THE SPARE, and it exists to break ONE loop: a bot dies, respawns empty, and
//     _assessDeathPile's fist veto refuses to send an unarmed bot after the pile holding its sword, so it
//     walks back to the same mobs unarmed and dies again. The veto is correct and stays; what was missing
//     is any OTHER way to become armed. `kind: 'tool'` makes this the first TIERED storage row: the chest
//     counts family-wide (a wooden spare still unbricks a dead bot) while what is CRAFTED resolves to the
//     best tier available. NO upgrade test, deliberately — a chest cannot fight, so asking "is what I
//     could make better than what is held" only re-crafts as the fleet's materials improve and fills the
//     chest with obsolete spares.
const STOCK_THRESHOLDS = [
    { item: 'pickaxe',        holder: 'bot', kind: 'tool', deficit_below: 2, dump_threshold: 2, mode: 'active' },
    { item: 'axe',            holder: 'bot', kind: 'tool', deficit_below: 1, dump_threshold: 1, min_tier: 'stone', mode: 'active' },
    { item: 'sword',          holder: 'bot', kind: 'tool', deficit_below: 1, dump_threshold: 1, min_tier: 'stone', job_type: 'crafting_weapon', mode: 'active' },
    { item: 'tools',          holder: 'bot', dump_threshold: 99 },
    { item: 'shield',         holder: 'bot', deficit_below: 1, dump_threshold: 1, job_type: 'crafting_defense', mode: 'passive' },
    { item: 'crafting_table', holder: 'bot', deficit_below: 1, dump_threshold: 1, mode: 'active' },
    { item: 'torch',          holder: 'bot', deficit_below: 12, dump_threshold: 32, mode: 'active' },
    { item: 'planks',         holder: 'bot', deficit_below: 12, dump_threshold: 20, job_type: 'resource_pillaring_stock', mode: 'active' },
    { item: 'stick',          holder: 'bot', dump_threshold: 8 },
    { item: 'dirt',           holder: 'bot', dump_threshold: 20 },
    { item: 'cobblestone',    holder: 'bot', deficit_below: 9, dump_threshold: 20, mode: 'active' },
    { item: 'raw_iron',       holder: 'bot', dump_threshold: 0 },
    { item: 'wheat',          holder: 'bot', dump_threshold: 0 },
    { item: 'saplings',       holder: 'bot', dump_threshold: 0 },

    { item: 'bread',       holder: 'storage', deficit_below: 8, dump_threshold: 32, mode: 'passive' },
    { item: 'logs',        holder: 'storage', deficit_below: 20, dump_threshold: 99, mode: 'active' },
    // CHARCOAL HAS NO ROW, AND THAT IS THE DESIGN (Architect, this round). Its row asked a chest to hold
    // ten at all times, which is a SCHEDULE — it produced charcoal whether or not anything wanted any, and
    // it was the only charcoal request in the fleet, so a bot needing three for its own torches had to
    // borrow it: the shelf's size, the shelf's destination, and an empty pocket at the end of the errand.
    // Demand for charcoal is DERIVED (twelve torches means three) and a derived quantity cannot be written
    // as a standing number without being wrong for every case but one. The board publishes what live
    // orders want (`materials_wanted`), assessors/furnace sizes the cook from that, and the dumper reads it
    // to know a carried stack is spoken for. Re-adding a row here re-creates the schedule beside the
    // request and the fleet is back to two answers (Law 16).
    //
    // IRON KEEPS ITS ROW ON PURPOSE — the distinction is worth stating so this is not read as "furnace
    // outputs do not get rows". A shelf level is right for material the fleet wants BANKED against future
    // work it cannot yet name; it is wrong for material that only ever exists to be consumed by an order
    // that already exists.
    { item: 'iron_ingot',  holder: 'storage', deficit_below: 20,  dump_threshold: 20, mode: 'active', after_fulfilled: 'logs' },
    { item: 'wheat_seeds', holder: 'storage', deficit_below: 2, dump_threshold: 32, job_type: 'supply_seeds', mode: 'active' },
    { item: 'bone_meal',   holder: 'storage', deficit_below: 8,  dump_threshold: 32, job_type: 'crafting_flat', mode: 'passive' },
    { item: 'sword',       holder: 'storage', kind: 'tool', deficit_below: 1, dump_threshold: 1, min_tier: 'stone', job_type: 'crafting_weapon', mode: 'passive' },
];

// Load-time integrity (Law 13), living HERE rather than in a test file because this module owns the data
// — preflight loads every fragment, so this runs on every change for free. Every check below
// guards the same failure shape: a field that reads `undefined` produces NaN or a `??` fallback, so the
// row posts nothing, or posts under a default, SILENTLY, for as long as nobody notices.
for (const row of STOCK_THRESHOLDS) {
    // The holder is the LAYER, and only two exist. An unrecognised value would read as neither pocket
    // nor storage at every consumer's discriminator and the row would simply never post — silently, for
    // as long as nobody noticed. Catches the old per-chest address (`{ blueprint, chest }`) on sight.
    if (row.holder !== 'bot' && row.holder !== 'storage') {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `has holder ${JSON.stringify(row.holder)}. The only holders are 'bot' (the pocket) and 'storage' `
            + `(the fleet's chest system as one pool). A request is fleet-wide and is never addressed to a `
            + `named chest, and there are no chest roles — see the holder note above this table.`);
    }
    if ('role' in row) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `still declares a chest 'role'. Roles ('requester'/'buffer') are deleted: buffer goes into any `
            + `chest and a request is filled from any chest.`);
    }
    if ('target' in row) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `still uses a removed field name. 'target' became 'keep', which became 'dump_threshold'.`);
    }
    if (typeof row.dump_threshold !== 'number') {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `has no numeric 'dump_threshold'. Every stock must declare how much survives a dump.`);
    }
    // Undeclared, a mode falls back to whatever the row's SHAPE implies — the inference this field
    // exists to end. Defaulting it here would rebuild that trap with a nicer name.
    if (row.deficit_below != null && row.mode !== 'active' && row.mode !== 'passive') {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `declares deficit_below ${row.deficit_below} but mode '${row.mode}'. Every restocked row must declare `
            + `mode: 'active' (the shortfall drives acquisition) or 'passive' (it is filled from what `
            + `already exists). Gating is an overlay on top of either, never a third mode.`);
    }
    if (row.job_type != null && JOB_TYPE[row.job_type] === undefined) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `declares job_type '${row.job_type}', which is not a job type in JOB_TYPES. `
            + `The row would post under its branch's default instead, silently.`);
    }
    // The inverse: a mode on a row with no `deficit_below` states a policy for a shortfall that is never computed,
    // so it reads as live governance over a row nothing restocks.
    if (row.deficit_below == null && row.mode !== undefined) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `declares mode '${row.mode}' but no 'deficit_below'. A hold-only row has no shortfall to answer for.`);
    }
}

// ── Canopy clearing (camera framing) ──
// Proactive tree-clear around opted-in surface blueprints so the base reads clean on camera — distinct
// from log-SUPPLY felling, which harvest_executor drives on demand. The radius is a square (Chebyshev)
// half-extent around build_center; raise it freely to open more ground, since there is no cultivated tree
// farm to preserve. job_board._treeInClearRadius sweeps r·√2 to reach this square's CORNERS (a Chebyshev
// corner is 1.41× the half-extent) — that derives from this constant, so it scales; a fixed slack margin
// would assume a small radius and miss corner trees once this grows large.
const TREE_CLEAR_RADIUS = 64;
// OPT-IN: only blueprints named here are cleared. The phase-1 farm is absent deliberately — it is
// scattered riverbank plots, not one framed field, so per-blueprint clearing does not apply.
const CANOPY_CLEAR_BLUEPRINTS = [
    'headframe',
];

// Materials a build proceeds WITHOUT. Deliberately EMPTY: a light source is not decoration, and a shell
// that reports itself done while unlit is a shell that sends bots out after dusk under an exemption that
// only exists because the shell is unfinished. Anything listed here can hold a build open forever without
// ever blocking it, which is the shape that killed a bot. Keep it empty unless a material genuinely
// cannot be obtained by the fleet at all.
const OPTIONAL_BUILD_MATERIALS = new Set([]);

// Biomes the bot will settle and build in. Outside this set, exploration seeks a new biome first.
// Narrowed to the low-altitude plains + forest families: the wider set let the bot settle on
// hilly/awkward "acceptable" terrain (taiga, savanna, jungle, snowy) where the staircase prism kept
// failing to find a flat build center. Meadow is excluded too — it generates on mountainsides, so its
// grass reads "acceptable" while the terrain is high and steep.
// Flat, well-wooded, low-threat only; this is the same gate find_buildingspot enforces.
const ACCEPTABLE_BIOMES = new Set([
    'plains', 'sunflower_plains', 'forest', 'birch_forest',
    'flower_forest', 'dark_forest', 'old_growth_birch_forest',
]);

// Smelting. Fuel preference order (first one held is used; logs excluded — a log burns like a
// plank but is worth four, so it is 4x the waste). Yield = smelts per fuel unit; cook = ms per
// item (vanilla 200 ticks = 10s), `default` covering every smeltable.
// "FUEL" MEANS WHAT A FURNACE BURNS AND NOTHING ELSE. This is a BURN ORDER, never a group: it says
// which held item to feed the fire first, never that the members are interchangeable to a job that has
// to GO AND GET one. Coal is mined and charcoal is smelted, so an acquisition category spanning both
// resolves a shortfall to a token with no producer. A torch's need for charcoal is a separate
// calculation with a separate table (`substitutes_for`), and merging the two re-creates that hole.
//
// CHARCOAL IS BANNED FROM THIS LIST: A FUEL THAT COSTS FUEL TO MAKE IS THE FURNACE FEEDING ITSELF.
// Charcoal is the only candidate fuel with a production overhead — smelting the log that becomes it burns
// 1/8 of a charcoal, and it occupies the furnace for a full cook (200 ticks) per unit. Planks have neither
// cost: a log crafts to four planks instantly, in the pocket, with no station and nothing burned. So
// admitting charcoal here spends the scarce resource (station time on the ONE registered furnace the
// whole fleet queues on) to manufacture the abundant one (fuel, which logs already provide for free),
// and the batch that was actually wanted waits behind it.
//
// THE YIELD ARGUMENT IS NOT THE REASON AND MUST NOT BE WRITTEN IN AS ONE, because it points the other
// way and a successor who re-derives it would find this comment false and re-admit charcoal. Net of its
// own overhead a log still returns more smelts as charcoal than as planks: 8 logs plus one borrowed
// charcoal yields 8 charcoal, net 7 after repaying the loan, = 56 smelts (7.0/log), against 32 planks
// at 1.5 = 48 (6.0/log). Jumpstarting from planks instead of borrowing still lands at 6.86/log. The ban
// is bought with roughly a sixth of the log-efficiency, deliberately, for a furnace that is never busy
// making its own fuel.
//
// RESERVATION, the second cost: charcoal is the torch chain's only ingredient, so a charcoal burned here
// is a torch not made, and the smelter would be consuming the output of the chain it exists to feed.
//
// Deleting it from the list is the whole ban — `_heldFuel` in assessors/furnace and `selectFuel` here
// both walk this array and nothing else, so there is one pathway and no second place to re-admit it
// (Law 16).
const FUEL_PREFERENCES = ['coal', 'planks'];
const FUEL_SMELT_YIELD = { coal: 8, planks: 1.5 };
const SMELT_COOK_MS    = { default: 10000 };

// ── GROUND SALVAGE CLOCKS ──────────────────────────────────────────────────────────────────────────
// WORTH IS DERIVED, NEVER AUTHORED: STOCK_THRESHOLDS already publishes what an item is worth to the
// fleet — under `deficit_below` is worth fetching, at or above `dump_threshold` is worth nothing, since the dump executor
// would bank it ten seconds after carrying it home. A second hand-authored worth table is a rival
// opinion that drifts silently from the first. The deficit IS the worth, per-bot and per-moment.
//
// Vanilla despawn for a dropped item. NOT a tunable — a fact about the server. The arrival margin is
// the only judgement in the pair.
const ITEM_DESPAWN_MS = 5 * 60 * 1000;

// How much of the despawn clock must remain AFTER the estimated arrival for the trip to be worth starting.
// Arriving with only a few seconds left means arriving to bare ground: the sweep itself takes time, and
// the route estimate is an estimate. Raise it if bots keep arriving to piles that just vanished.
const RETRIEVAL_ARRIVAL_MARGIN_MS = 45 * 1000;

// Route cost → milliseconds, for the despawn comparison. Deliberately PESSIMISTIC: one unit of A* cost is
// about one walk step, a bot covers a few blocks per second on flat ground, and a route with digs and
// pillars in it moves far slower than its cost suggests. Over-estimating travel time fails SAFE (refuse a
// trip that would have just made it) where under-estimating fails EXPENSIVE (walk the whole way to bare
// ground). Law 13 default-stopped, applied to an estimate.
const RETRIEVAL_MS_PER_COST_UNIT = 400;

// NO "reconsider a refusal after N blocks" rule, and the question it answered no longer exists: a refusal
// keyed to the POSITION it was priced from needs a distance at which to re-open, but the salvage executor
// keys refusals to the ENTITY ID, which expires when the item does.

// ── COMPOST → BONE MEAL ────────────────────────────────────────────────────────────────────────────
// Waste (leaf litter, saplings) into bone meal. `leaf_litter` is the compostable block — leaf BLOCKS need
// shears the fleet does not craft and are deliberately not in this chain. THE RATE IS HONEST AND SLOW:
// each compostable has a 30% chance of one level, seven levels make one bone meal, and one bone meal is
// one growth stage of one plant. It accelerates the farm; it does not transform it.
//
// COMPOSTING IS NOT A JOB AND MUST NOT BECOME ONE AGAIN. The composter was modelled as a standing order —
// dump files a sapling in a chest, a standing request pulls it back out — and the flaw is that pulling it
// back out is ITSELF a job, which can sit posted and unclaimed indefinitely while every bot is on
// higher-ranked work. A perfectly-formed request is worthless if nobody is ever free to answer it.
// Instead the dump places compostables directly in the bin: one stop further on a trip already owed,
// with no rank, no request, no retrieval, no job. For the same reason there is no batch floor here —
// there is no trip to amortise, so a floor would only mean carrying saplings past a bin the bot is
// standing next to.
//
// COMPOST_INPUTS is an opt-in list: anything not named is never fed to a composter. `wheat_seeds` is
// ABSENT despite being compostable — seeds are the farm's scarcest input (the till budget is a pure
// function of it), one seed is a planting, and converting it to a 30% chance of one-seventh of a bone
// meal is a loss in every world. Its row is storage-held, so no bot dump threshold would defend it either.
// The intent "compost anything above the seed reserve" is correct and blocked on ONE link: the dump
// offers a wanting storage row the item before the bin, but the chest-selection test asks whether the chest
// has a free SLOT rather than whether it already holds its `dump_threshold`, so storage accepts seeds past its
// cap forever. Adding the token today would be inert while reading as done. The change owed is a
// threshold-aware storage test — a new mechanism, not a toggle (Law 22 gate 2; Law 25).
const COMPOST_INPUTS = ['saplings', 'leaf_litter'];

// How far from a blueprint centre the executor looks for a placed composter.
const COMPOST_SEARCH_RADIUS = 24;

// A composter is FULL at level 8 and yields exactly one bone meal when harvested. Not a tunable — it is
// the block's own state machine, named here so the executor reads it from one place.
const COMPOSTER_READY_LEVEL = 8;

// Bone meal applied per crop, and the growth stage a wheat plant must be BELOW to be worth one. Mature
// wheat is stage 7; feeding a plant that is already harvestable is pure waste, so the executor skips it.
const BONE_MEAL_MAX_CROP_STAGE = 6;

// Integrity passes the mining manager runs BACK-TO-BACK before surfacing the bot, dumping, and handing
// to the judge. WHY BATCH: every hand-back is a fork where the brain may pick a SURFACE job instead, and
// a bot that hands back while deep makes the next task's pathfinder carve a fresh diagonal toward its
// target — cheaper than climbing the staircase — scarring the ground beside the shaft. So the manager
// surfaces on EVERY hand-back and pays the descent once per N segments instead of once per segment.
// Higher = fewer surface trips, more work per trip; lower = more responsive replanning.
const MINING_PASSES_PER_DISPATCH = 3;

// ── THE STONE PROSPECT — a shaft dug for its own material, not for a mine ─────────────────────────
// The other two digs both belong to the headframe and need a surveyed site before either can post, so
// everything downstream of cobblestone waited on a base being sited. Stone is abundant at almost every
// surface XZ, so a bot needing a furnace or a stone tool digs one 1-wide column, takes what it came for,
// and seals it behind — no site, no staircase, no standing mine.
//
// FIXED YIELD, NO ARITHMETIC: the run is not sized against the order. Nine covers a furnace (8) with one
// spare and equals a stone pickaxe, sword and axe together, so one trip arms and equips a bot either way.
// Sizing per order buys a shallower hole on a small ask and pays for it with a second whole trip on the
// next — and the SCAN is the expensive part of this verb, not the digging.
//
// `stone_run` is a GATE and `max_overburden` is a PREFERENCE; the scanner ranks them rather than scoring
// them together (stone_column_scanner's header holds why blending them is the trade never to make).
//
// `filler_reserve` is what makes the descent REVERSIBLE — sealing costs one placeable block per block
// dug, and the overburden mines back into the pocket to pay its own share, so the reserve covers only the
// stone half. Checked BEFORE the first dig (Law 13): a bot that discovers the shortfall at the bottom of
// the shaft has discovered it in the one place it cannot act on it.
//
// NO `filler_items` LIST HERE ANY MORE. It existed to keep cobblestone out of the climb — the canonical
// pillar order used to reach MASONRY before SOIL, so a bot out of timber climbed out on the exact stone
// it descended for and surfaced holding none of it (Law 25: a verb consuming its own product and still
// reporting success). The canonical order now spends soil first and masonry last, so the hazard is
// structural rather than avoided by a local copy, and the copy became an eighth hand-maintained
// placement order competing with the one it was insuring against (Law 16). The executor reads
// `group_to_item.pillar_block` to climb and `scaffold_spendable` to count `filler_reserve`. Do NOT
// re-add a list here: a second order is exactly what made the first one wrong and invisible.
// `max_approaches` is a bounded walk, not a budget: a bot boxed in by terrain would otherwise pay a full
// pathfind against every column in the batch before admitting it can reach none of them.
const STONE_PROSPECT = {
    stone_run: 9,            // uninterrupted `stone` blocks the column must hold — THE GATE
    max_overburden: 6,       // non-stone ground above the run before the column is refused
    min_radius: 2,           // never open a shaft in the cell the bot is standing on
    max_radius: 24,          // outer edge of the search; past this the walk costs more than a deeper hole
    scan_batch: 64,          // columns probed before the scanner stops to ask "did anything fit?"
    max_batches: 4,          // batches before the sweep concedes and the caller replans
    scan_up: 16,             // search window above the bot's feet, for a column upslope of it
    scan_down: 24,           // and below, for one downslope
    max_approaches: 8,       // ranked columns claimed-and-approached before conceding — a bounded walk
    filler_reserve: 12,      // placeable non-stone blocks required in hand before the descent begins
};

// TWO NUMBERS IN TWO TABLES THAT MUST AGREE, made to say so at load rather than in a comment either one
// can be edited without reading. The prospect refuses to descend below `filler_reserve`; the planks row
// is the only SOUGHT supply of that material (soil and sediment also count toward the reserve, but the
// fleet gathers neither — they arrive incidentally or not at all), and its `deficit_below` decides
// whether a shortfall ever POSTS. A
// floor beneath the reserve leaves the row silent in exactly the state that blocks every stone job — the
// bot above its own floor and under its consumer's requirement, indistinguishable in a trace from a row
// that is working.
const _plankFloor = STOCK_THRESHOLDS.find(r => r.item === 'planks' && r.holder === 'bot');
if (!_plankFloor || _plankFloor.deficit_below < STONE_PROSPECT.filler_reserve) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): the bot's planks floor `
        + `(min ${_plankFloor ? _plankFloor.deficit_below : 'ROW MISSING'}) is below STONE_PROSPECT.filler_reserve `
        + `(${STONE_PROSPECT.filler_reserve}). The prospect would refuse to descend for want of sealing `
        + `material while the row that supplies it reads satisfied, and every stone job would stall.`);
}

// THE SECOND HALF OF THE SAME REQUIREMENT IS NO LONGER A THROW HERE, AND MUST NOT BE RE-ADDED AS ONE.
// The floor above decides whether the seal ever POSTS; a second rule used to decide whether the bot ever
// REACHES it, by asserting that no stone-consuming job type is listed above the planks supplier in the
// 'bot' band. That rule could only be stated as an assertion about ARRAY POSITION, because array position
// was the tiebreak — and a dependency enforced by where a line sits in a file is a dependency nothing can
// read (Invariant C). It also could not say what it was protecting: the failure it prevented is a bot
// descending into a hole it cannot climb out of, which is a fact about what the bot HOLDS, not about what
// order the table lists.
// It is `job_gates.fillerGate` now: a stone order is HELD, with its reason named, until the bot carries
// `filler_reserve` spendable blocks. Same guarantee, stated where it is true, and it holds correctly for
// a bot that lost its planks mid-run — which the ordering rule never could, because a table cannot sense
// a pocket (Invariant B).

// ── Combat / engagement tunables ──
// "Inside base" = within this many blocks (horizontal) of the headframe's build_center — the shared
// stations/chests zone, where the bot seek-and-destroys any hostile. Outside it, engage only on aggro.
const HEADFRAME_SAFE_RADIUS = 32;
// Base spacing. The ANCHOR blueprint (strictest siting criterion — currently the farm) is located first;
// satellites site from its center, nearest-first. The ONLY building-to-building constraint is NON-OVERLAP:
// this is the clearance find_buildingspot keeps between any two footprints. Raise to spread the base,
// lower to pack it (floor of 1 keeps footprints from touching). SEPARATE from BUFFER_BLOCKS in
// building_site_overlays, which is one candidate's own navigation clearance.
// NO max-spread-from-anchor cap, deliberately: water banks are terrain-scarce, so a second clear riverbank
// can legitimately be far from the first, and a distance cap hard-stops the WHOLE base rather than accept
// a distant-but-buildable farm. Nearest-first already keeps the layout as tight as the terrain allows.
const MIN_BLUEPRINT_SPACING = 8;

// Square (Chebyshev) half-extent around EVERY locked build_center inside which opportunistic RESOURCE
// GATHERING is forbidden. Building and tending are still allowed; this bans only the dig-anything scan.
// WHY: gathering is terrain-blind, so the densest patch of free ground near a riverbank base IS the farm
// cluster — a short bot mines the plot cells out of the base it just sited, like any other block.
// A SEPARATE knob on purpose: MIN_BLUEPRINT_SPACING is a spacing rule and HEADFRAME_SAFE_RADIUS is a
// combat zone, and conflating a spacing rule with a behaviour zone (Law 16) makes all three drift the
// moment one is retuned. Sized as a halo just around each footprint — the plots abut, so the halos merge
// into one skirt — without shading the surrounding gather field.
const HARVEST_KEEPOUT_RADIUS = 8;

// The farm runs as N INSTANCES of ONE blueprint — per-instance conference-room keys rather than
// duplicate-named blueprints, so there is one geometry to maintain (Law 16). Instance 0's key IS the
// blueprint name so a single-farm caller's default resolves; the rest suffix '#N'. Every farm reader
// threads the instance key, and the reader loop is the ONLY place the count is known (Invariant D), so
// growing the field is one edit here.
// The wheat_plot_scanner is the SOLE siter — it alone enforces the hydration Y-rule AND the cross-plot
// spacing. No water bucket, no fence, no iron. (Deferred: farming_integrity must capture each plot's
// dynamic water source to repair or rescan a damaged field.)
const FARM_BLUEPRINT_NAME = 'wheat_plot_pair';
const FARM_PLOT_COUNT = 32;
const FARM_ROOM_KEYS = Array.from({ length: FARM_PLOT_COUNT }, (_, i) =>
    i === 0 ? FARM_BLUEPRINT_NAME : `${FARM_BLUEPRINT_NAME}#${i}`);

// A hostile is "aggroed" iff within AGGRO_RANGE blocks AND has clear line-of-sight to the bot (the
// concrete A3 test — no mob-target introspection). DISENGAGE_RANGE must be > AGGRO_RANGE: backing out
// past it is a MUTUAL break (the mob deaggros past its own aggro radius too), so the evicted/retreating
// bot both drops its aggro test and loses the mob — a clean two-sided disengage.
const AGGRO_RANGE     = 15;
const DISENGAGE_RANGE = 20;

// ── PER-SPECIES AGGRO RANGE ────────────────────────────────────────────────────────────────────────
// ONLY THE SKELETONS ARE LISTED, and the emptiness of the rest is deliberate. The skeleton family has a
// wider follow range AND a bow reaching across all of it, so one just outside the flat radius shoots
// without ever entering the bot's scan — invisible to the engagement gate while landing arrows.
// THE RULE FOR ADDING A SPECIES IS ITS OWN REACH, NEVER ITS FOLLOW RANGE. A zombie's published follow
// range is where it starts WALKING toward the bot, not where it can touch it, so meeting that number buys
// a wider scan and no safety (Law 23: the published figure is a claim about targeting, and only the mobs
// that can ACT at that distance change what the bot should do).
// DISENGAGE_RANGE must stay above the LARGEST value here, not merely above AGGRO_RANGE — the two-sided
// break only holds if backing out clears the widest radius the bot honours.
const MOB_AGGRO_RANGE = {
    skeleton: 18,
    stray: 18,
    bogged: 18,
    wither_skeleton: 18,
};
const MAX_AGGRO_RANGE = Object.values(MOB_AGGRO_RANGE).reduce((m, v) => Math.max(m, v), AGGRO_RANGE);

// ── THE GATE IS A CYLINDER, NOT A SPHERE ───────────────────────────────────────────────────────────
// A sphere makes altitude and reach compete for one budget, and on open terrain altitude wins an argument
// the bot does not know it is having. Two separate questions: HOW FAR ACROSS can this species reach (the
// table above) and HOW FAR UP OR DOWN is it still the same fight (this constant, one number for every
// species). A mob a few blocks below on a ledge is a threat; the same mob thirty blocks down is terrain.
// THE RAYCAST CLAMP IS THE CYLINDER'S 3-D DIAGONAL, never the horizontal radius: a cast clamped shorter
// than the gate admits declines a mob the gate accepted, and declines it as "no_sightline" — a false
// reason, worse than a refusal (Law 25). The vertical figure and the raycast reachability bound in
// combat_lens are set independently on purpose; if the lens's bound equalled this, the check would be
// tautological, and an instrument that can no longer disagree with the gate is not measuring it (Law 26).
const AGGRO_VERTICAL_RANGE = 8;
const MAX_CAST_RANGE = Math.hypot(MAX_AGGRO_RANGE, AGGRO_VERTICAL_RANGE);
// MEASURED AGAINST THE DIAGONAL, not the radius: the diagonal is the farthest a mob can be and still be
// aggroed, so a retreat sized to the radius alone leaves the cylinder's corner unclearable and the bot
// jogs outward forever, still aggroed.
if (DISENGAGE_RANGE <= MAX_CAST_RANGE) {
    throw new Error(`[architect_config] DISENGAGE_RANGE ${DISENGAGE_RANGE} must exceed the aggro cylinder's ` +
        `diagonal ${MAX_CAST_RANGE.toFixed(2)} (widest radius ${MAX_AGGRO_RANGE} × vertical ${AGGRO_VERTICAL_RANGE})`);
}

// The HORIZONTAL radius this species is honoured at. THE ONE ROUTE for the table lookup (Law 16) — but on
// a live fight path the question is "is this mob inside it", which has its own route below. A call site
// that takes this number and compares a 3-D `distance` to it has rebuilt the sphere this section deleted.
function aggroRangeFor(name) {
    if (!name) return AGGRO_RANGE;
    return MOB_AGGRO_RANGE[String(name).toLowerCase()] || AGGRO_RANGE;
}

// The cylinder's diagonal, so no admitted mob is ever refused by the cast's own length. Rounded UP: the
// predicate steps in whole voxels, and a fractional clamp truncates one step short of the mob it was
// sized for.
function aggroCastRange(name) {
    return Math.ceil(Math.hypot(aggroRangeFor(name), AGGRO_VERTICAL_RANGE));
}

// THE ONE ROUTE for the gate itself (Law 16) — the commander's verdict, the scanner's confirm and the
// decline report all ask this, so the shape moves in one edit. Plain {x,y,z} rather than Vec3 so benches
// and monitors can ask the bot's own question without dragging prismarine into a reader (Law 26).
function withinAggroRange(self, pos, name) {
    if (!self || !pos) return false;
    if (Math.abs(pos.y - self.y) > AGGRO_VERTICAL_RANGE) return false;
    return Math.hypot(pos.x - self.x, pos.z - self.z) <= aggroRangeFor(name);
}
// Block-light level at/under which a surface cell is "dark" and gets a torch — the ONE lighting
// trigger for BOTH the auto-torch reflex and the torch_integrity base sweep (Law 16, one light-driven
// pathway). Not 0: topping up at ≤3 keeps the walked/guarded ground comfortably above the spawn
// threshold with denser, self-spacing torches. NOTE: survival_instincts.js is atomic (no project
// imports) so it re-declares this same 3 locally — keep the two in sync; this is the canonical home.
const TORCH_LIGHT_FLOOR = 3;

// Hunger / eating (Law 17 self-preservation). Minecraft food is 0–20. TWO-TIER model — reverses an
// earlier "never drift toward food-0" rule that made a hungry-with-no-food bot throw immediately, which
// is guaranteed on any fresh start because the farms haven't grown the first loaf yet:
//   SHOULD-EAT (HUNGER_EAT_THRESHOLD, 18): eat at/below this. 18 is also the regen floor, so eating here
//     keeps health regen alive. But should-eat is NON-FATAL — if NO food exists yet, the bot does NOT halt;
//     it keeps working (farming the very food it needs) and re-tries eating as food drains. job_board gates
//     the should-eat job on food actually being reachable, so a hungry-but-unfed bot picks real work instead
//     of a survival job it cannot fill (that gate is what buys the farms the 18→0 window to produce).
//   MUST-EAT (HUNGER_MUST_EAT_THRESHOLD, 0): the hard floor. At/below it, eat_executor throws the Law 13 halt
//     even with no food — the run rides the whole should-eat→must-eat runway and halts only if it reaches
//     truly empty. Set to 1 (not 0) if you want to guarantee not even a single starvation-damage tick lands.
// HUNGER_FULL is the eat-to ceiling (20). All dormant on peaceful — food never drains.
const HUNGER_EAT_THRESHOLD      = 18;
const HUNGER_MUST_EAT_THRESHOLD = 0;
const HUNGER_FULL               = 20;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTROL PROGRAM — the two species, the sign claim, and the one-line order grammar
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// FOREMAN — the in-game desk. Not a bot: a headless client standing in the world so a human has somebody
// to talk to. It fetches a CREW, commands it, and takes its work orders; every bot it gets is a
// contractor by construction. Named `valet` until 2026-08-30, when the scope outgrew a word that only
// meant fetch-and-dismiss.
//
// FOREMAN_CHANNEL is where it listens, and swapping it is this one line — the foreman asks the channel for a
// command stream and never touches a mineflayer event directly, so the choice is not spread through the
// parser. Only the open-chat side is BUILT; the whisper side is a declared, deliberately unimplemented
// seam that throws rather than falling back, because a silent fallback would look exactly like a working
// switch while broadcasting every command the switch existed to make private.
const FOREMAN_CHANNELS = Object.freeze({ OPEN_CHAT: 'open_chat', WHISPER: 'whisper' });
const FOREMAN_CHANNEL = FOREMAN_CHANNELS.OPEN_CHAT;

// The word that makes a line addressed to the foreman rather than ordinary conversation. Everything
// else the foreman hears is somebody talking, and it is ignored without comment — a clerk that answers
// unaddressed remarks is noise in a recording.
const FOREMAN_PREFIX = 'foreman';

// The foreman's own player name in the world. It holds a slot on the server like any client, and it is
// NOT in BOT_SENIORITY: the roster is bots, and the foreman is staff.
const FOREMAN_NAME = 'Foreman';

// BOT_MODES — the mandate vocabulary. A bot is one of these AT BIRTH and never changes.
//   homesteader — answers to nobody, started from the TERMINAL. It never mounts a chat listener, so it
//                 does not refuse a human's instruction: it has no ear to receive one.
//   contractor  — purpose-built for human use. Spawned from IN-GAME chat, hears humans, works their
//                 orders, and yields to their instructions except where its own safety is at stake.
// The isolation lives in WHICH CODE IS LOADED, never in a permission consulted at call time — that is
// the difference between two species and one species with a rule, and why the mandate is read once at
// boot rather than checked per command.
const BOT_MODES = Object.freeze({ HOMESTEADER: 'homesteader', CONTRACTOR: 'contractor' });

// The mode stamped on a terminal launch. Stated here rather than defaulted at the read site: bot_mandate
// throws on an ABSENT mode, and fleet_control stamps this so the field is never absent. A default at the
// reader would make a mis-wired launcher look like a working homesteader (Law 13).
const TERMINAL_SPAWN_MODE = BOT_MODES.HOMESTEADER;

// ── THE SIGN ORDER DESK WAS DELETED 2026-08-30, UNBUILT (Architect) ──────────────────────────────
// It was a full design and never had one consumer: SIGN_CLAIM_EDGE / SIGN_CLAIM_VERTICAL_OFFSET /
// SIGN_CLAIM_HALF_EXTENT (an 11³ chests-only cube claimed by a sign), SIGN_LINE_MAX_CHARS (a 12-char
// budget standing in for the vanilla editor's unmeasurable ~90 px ceiling), and the alias-length
// guarantee derived from it. Nothing in perception, action or thinking ever read a sign.
//
// Orders now arrive by speaking to the FOREMAN, and the reason is a property signs cannot have: *"signs
// are too small and can be destroyed or tampered with by other humans. talking directly to the forman is
// tamper proof."* A sign is world state — any player can break it, overwrite it, or build one that lies.
// A chat line is authenticated at the packet layer and reaches one listener that answers by name.
//
// Keeping both would be two intakes for one capability (Law 16), and the unbuilt one reads as a live
// feature to a cold-start session. `tools/sign_probe.js` stays: it is a probe, not an intake.
//
// ORDER_ALIASES SURVIVED, and it is now the FOREMAN'S vocabulary. It was never really about pixel
// width — it is the answer to "what did the human mean", and a chat line needs that as much as a sign
// did. The length ceiling went with the sign; the lowercase rule stayed, because chat is compared
// lowercased and a capital here is a word no human could ever match.

// The short word a human says, and the item it means.
// A HUMAN'S ORDER IS A CLAIM, NOT A FACT (Law 23): the desk resolves through this table and REFUSES an
// unknown word rather than guessing a nearest match, because a guess is a bot cheerfully delivering the
// wrong thing on camera.
const ORDER_ALIASES = Object.freeze({
    cobble:  'cobblestone',
    stone:   'stone',
    plank:   'oak_planks',
    oak_log: 'oak_log',
    log:     'oak_log',
    iron:    'iron_ingot',
    gold:    'gold_ingot',
    coal:    'coal',
    torch:   'torch',
    glass:   'glass',
    dirt:    'dirt',
    sand:    'sand',
    wheat:   'wheat',
    bread:   'bread',
    stick:   'stick',
});

// THE GUARANTEE'S HOME IS HERE, not in a test file (the one-test rule). It catches the alias nobody
// could ever say, at require time in every process, rather than the first time a human tries that word
// at the far end of a recording session.
//
// THE LENGTH CEILING WENT WITH THE SIGN. It existed to fit `<alias> <qty>` inside a 12-character line
// on a sign face; a chat line has no such budget, so an alias is now as long as it is useful.
for (const alias of Object.keys(ORDER_ALIASES)) {
    if (alias !== alias.toLowerCase()) {
        throw new Error(`CODING VIOLATION (Law 13): order alias "${alias}" is not lowercase — a human's words are compared lowercased, so a capital here is a word no human can ever match.`);
    }
}

module.exports = {
    WORLD_DEPTH_FLOOR_Y,
    SPAWN_PROTECTION_RADIUS,
    PERSON_CLEAR_OF_SPAWN,
    SERVER_MINECRAFT_VERSION,
    SERVER_ENDPOINT,
    BOT_SENIORITY,
    FOREMAN_CHANNELS,
    FOREMAN_CHANNEL,
    FOREMAN_PREFIX,
    FOREMAN_NAME,
    BOT_MODES,
    TERMINAL_SPAWN_MODE,
    ORDER_ALIASES,
    JOB_TYPE,
    JOB_CATEGORY_OF,
    JOB_STAGE_OF,
    JOB_STANDING,
    CATEGORY_NAMES,
    CATEGORY_INDEX,
    PRE_BAND,
    PRE_BAND_MEMBERS,
    STAGES,
    STAGE_INDEX,
    WOOD_PREFERENCE_CHAIR_FIELD,
    ITEM_DESPAWN_MS,
    RETRIEVAL_ARRIVAL_MARGIN_MS,
    RETRIEVAL_MS_PER_COST_UNIT,
    COMPOST_INPUTS,
    COMPOST_SEARCH_RADIUS,
    COMPOSTER_READY_LEVEL,
    BONE_MEAL_MAX_CROP_STAGE,
    MINING_PASSES_PER_DISPATCH,
    STONE_PROSPECT,
    isNightTime,
    isPeacefulWorld,
    isDaylightOnlyJob,
    mayGatherOutdoors,
    TREE_CLEAR_RADIUS,
    CANOPY_CLEAR_BLUEPRINTS,
    HEADFRAME_SAFE_RADIUS,
    MIN_BLUEPRINT_SPACING,
    HARVEST_KEEPOUT_RADIUS,
    FARM_BLUEPRINT_NAME,
    FARM_PLOT_COUNT,
    FARM_ROOM_KEYS,
    AGGRO_RANGE,
    MOB_AGGRO_RANGE,
    MAX_AGGRO_RANGE,
    AGGRO_VERTICAL_RANGE,
    aggroRangeFor,
    aggroCastRange,
    withinAggroRange,
    DISENGAGE_RANGE,
    TORCH_LIGHT_FLOOR,
    HUNGER_EAT_THRESHOLD,
    HUNGER_MUST_EAT_THRESHOLD,
    HUNGER_FULL,
    TYPE_COORDINATES,
    TYPE_BLUEPRINT_PASTED,
    TYPE_STRUCTURE_COMPLETE,
    BUILDING_REQUIREMENTS,
    REQUESTABLE_STRUCTURES,
    STOCK_THRESHOLDS,
    OPTIONAL_BUILD_MATERIALS,
    ACCEPTABLE_BIOMES,
    FUEL_PREFERENCES,
    FUEL_SMELT_YIELD,
    SMELT_COOK_MS,
};
