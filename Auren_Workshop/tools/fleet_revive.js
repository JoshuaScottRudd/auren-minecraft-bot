// bench: fleet_revive — the two preflight questions a CONTINUE has to answer that a STANDARD never does.
//
// A standard test restores a snapshot, so both questions are answered by construction: the HQ it starts
// from is whatever the snapshot carried, and every playerdata file in it holds a live body. A continue
// carries the last run's world and HQ forward, so it inherits whatever state the last run *ended* in —
// and a run can end at any instant, including the instant after a death.
//
// ── WHY THIS LIVES OUTSIDE BOT CODE (Architect 2026-08-14) ────────────────────────────────────────────
// "should be a reuse of death manager but outside of bot code into the conductor."
//
// death_manager owns death recovery under autonomy and is the right owner there. It cannot be the owner
// HERE, and the reason is a startup ordering that no amount of in-bot code can escape: master_core runs
// `bot.once('spawn', ...)`, and a client that logs in onto a corpse never receives that event. So the
// fragment that would fix the corpse is inside the process that the corpse prevents from initialising.
// Every operator verb is on the far side of the same gate — `verb respawn` included, because the verb
// route needs master_core listening. A dead playerdata file is therefore not a bot-level fault at all;
// it is a fault in the world the fleet is about to be raised on, and the thing raising the fleet is the
// only party still able to act on it.
//
// What is reused is death_manager's SHAPE, which is the part that carries the reasoning: two acts, each
// a command followed by a sense (a respawn packet accepted is not a body; an RCON `tp` that returned
// cleanly is not an arrival), and the same tier-1 recovery cell derived from the same blueprint. What is
// deliberately NOT reused is its tier-2/tier-3 scan machinery — `building_integrity.scan` and
// find_buildingspot both need a live bot with loaded chunks, which is exactly what does not exist yet.
// The conductor's job is narrower than death_manager's and stops where death_manager's begins: get a live
// body standing somewhere sane, then hand over. Once master_core initialises, death_manager owns every
// death after this one, including the ones this file could not have chosen a good cell for.
//
// ── WHY DETECTION IS AN OFFLINE FILE READ AND REPAIR IS A CLIENT ─────────────────────────────────────
// The two halves have opposite costs. Detection has to run for every bot on every continue, and the
// answer is already sitting on disk: the server flushes playerdata on a clean stop, so `Health` in
// `<world>/playerdata/<uuid>.dat` is the state the next login will resume from. Reading it costs no
// connection and perturbs nothing. Repair only runs for a bot that is actually dead, and it genuinely
// requires a client, because a respawn is a packet only the client may send (the same fact death_manager
// records: the fleet can teleport a body as an operator, but it cannot respawn one).
//
// That split has a hard ordering consequence: repair MUST run before `bots-up`, because a username may
// hold exactly one connection and the repair client wears the bot's own name. The conductor sequences it
// accordingly, and this file refuses rather than fights if the name is already taken.
//
// ── WHY THE HQ AUDIT REFUSES INSTEAD OF REPAIRING ────────────────────────────────────────────────────
// corporate_headquarters already throws on a present-but-unreadable file, and that throw is correct and
// stays where it is — this is not a second opinion about the same question (Law 16). The difference is
// only WHEN it is asked. In-process, the throw fires after the fleet is raised, from inside one bot,
// three process layers below whoever asked for the run. Asked here, before anything is raised, the run
// refuses while there is still nothing to tear down (Law 8 — a conductor reaps only what it raised).
// It never rewrites an HQ it dislikes: the file holds the only copy of the build centre, the station map
// and every locked buildspot, and a repair that guessed wrong would destroy exactly what a continue exists
// to preserve. Default-stopped (Law 13) is the whole value here.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Resolve prismarine-nbt/mineflayer by ASKING the one file that knows where modules live on this machine.
// Doing it HERE rather than relying on an inherited NODE_PATH is not defensiveness: this file's whole job
// is to run as a CHILD of the conductor, which spawns with a clean environment, so an unresolvable require
// would surface as "playerdata unreadable" — a refusal blaming the world for a fault in this file. It did
// exactly that once and the refusal was right to fire; the message was the lie (Law 25).
//
// THE LIST WAS WRITTEN OUT HERE and that is what was wrong with it (Law 16). A private copy of "where do
// modules live" cannot stay in step with the machine layouts: this one named two directories and a third
// home exists, so on a layout carrying the package only in that third place this file reports a missing
// world instead of a missing module. The same private-copy defect was found in the foreman's door, where
// it took down every verb a human could speak. One resolver, asked by everyone.
const paths = require('../workshop_paths');
const { bootstrapModulePath, CANDIDATE_HOMES } = require(paths.bot('js_kernel/utils/node_module_homes'));
const moduleDirs = bootstrapModulePath();
// The @-aliases, registered against Auren_Bot's own package.json for the reason preflight spells
// out: bare `module-alias/register` walks up from the module's INSTALL dir and can land on a package.json
// with no _moduleAliases, registering nothing. Needed here because the recovery cell is read from
// blueprint_registry, which reaches for `@kernel/...` like every other file in the tree.
paths.registerAliases();

// The two acts of standing a body up, shared with death_manager and with every other place a body is
// stood up. Required AFTER the aliases because it reaches `@kernel/blueprint_registry` for the recovery
// cell — see body_recovery's header for why the acts are not written twice any more.
const recovery = require('@kernel/body_recovery');

const REPO_ROOT = paths.REPO_ROOT;
const SERVER_DIR = path.join(REPO_ROOT, 'MinecraftServer');
const HQ_DIR = paths.bot('js_kernel');

const TAG = 'fleet_revive';
const HQ_SCHEMA = 'auren.corporate_headquarters.v1';
// Only the LOGIN wait is this file's own: it is the one act body_recovery does not own, because only
// this caller builds a client at all (a corpse never reaches master_core, so the in-process path cannot
// exist here). Every window AFTER the login is body_recovery's, so the two paths cannot drift apart.
const LOGIN_WAIT_MS = 20000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The world's own records ──────────────────────────────────────────────────────────────────────────

// The roster is resolved HERE from its one declaration rather than passed in by name, so a caller only
// has to know how MANY bots it is raising. fleet_control derives its own the same way from the same
// constant; a conductor holding a third copy of the name list is the shape Law 16 forbids, and it would
// go stale exactly when a bot is added — the moment the audit matters most.
function roster(count = null) {
    const { BOT_SENIORITY } = require(paths.bot('Thinking_fragments/architect_config.js'));
    const all = Object.keys(BOT_SENIORITY).sort((a, b) => BOT_SENIORITY[a] - BOT_SENIORITY[b]);
    return count == null ? all : all.slice(0, Math.min(count, all.length));
}

// The world is READ from server.properties, never passed in with a default. A continue runs on whatever
// world the server is actually serving, and a preflight that assumed a name would audit one world's
// playerdata while the fleet was raised on another's — the value-used-to-check drifting from the
// value-used-to-act, which is the defect this conductor's own snapshot preflight was already bitten by.
// rcon_link owns the properties read (Law 16).
function currentWorld() {
    const { readServerProperties } = require(paths.bot('js_kernel/utils/rcon_link'));
    const name = readServerProperties().level;
    if (!name) throw new Error(`[${TAG}] server.properties carries no level-name, so there is no way to know which world a continue would run on.`);
    return name;
}

// The name→uuid map is the SERVER's, not ours. Deriving the offline-mode uuid ourselves would be a second
// implementation of a mapping the server already publishes, and the two would disagree the moment a bot is
// renamed or the server's mode changes (Law 16).
function botUuid(botId) {
    const p = path.join(SERVER_DIR, 'usercache.json');
    if (!fs.existsSync(p)) return null;
    let cache;
    try { cache = JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch (e) { throw new Error(`[${TAG}] ${p} could not be parsed (${e.message}). The server writes this file; a malformed one means the server did not stop cleanly.`); }
    const hit = Array.isArray(cache) ? cache.find(e => e && e.name === botId) : null;
    return hit ? hit.uuid : null;
}

// readBody(world, botId) → what the NEXT login will resume as.
//
// `found:false` is not a failure and must not be treated as one: a bot that has never joined this world
// has no playerdata, and vanilla will place it at world spawn alive. Naming that case apart from a dead
// body is the whole point of returning a reason (Law 25 — a tier that can only say "no" carries no
// information).
function readBody(world, botId) {
    const uuid = botUuid(botId);
    if (!uuid) return { found: false, alive: true, reason: `no usercache entry for ${botId} — it has never joined this server, so it will spawn fresh and alive` };
    const file = path.join(SERVER_DIR, world, 'playerdata', `${uuid}.dat`);
    if (!fs.existsSync(file)) return { found: false, alive: true, reason: `no playerdata for ${botId} in '${world}' — first join on this world, spawns fresh and alive` };

    let raw = fs.readFileSync(file);
    // Vanilla gzips playerdata, but the format permits it uncompressed and a hand-edited file often is.
    // Sniffing the magic rather than assuming means a legitimate uncompressed file reads instead of
    // throwing a confusing zlib error that looks like corruption.
    if (raw[0] === 0x1f && raw[1] === 0x8b) {
        try { raw = zlib.gunzipSync(raw); }
        catch (e) { return { found: true, alive: false, unreadable: true, reason: `${path.basename(file)} is gzipped but would not inflate (${e.message}) — treat as corrupt, not as dead` }; }
    }

    // The LOAD and the PARSE are separated because they are different classes of fault and only one of
    // them is about the world. A missing prismarine-nbt cannot happen in a correctly-installed tree, so
    // it throws (Law 13); folding it into the parse catch made this file report "playerdata unreadable"
    // for a fault in itself — a true refusal wearing a false reason.
    let nbt;
    try { nbt = require('prismarine-nbt'); }
    catch (e) {
        throw new Error(`[${TAG}] CODING/ENVIRONMENT VIOLATION: prismarine-nbt did not load (${e.message}). `
            + `This is not a fault in the world — nothing about ${botId}'s body has been read. Found module homes `
            + `[${moduleDirs.join(', ') || 'none'}] out of the ones this machine layout admits [${CANDIDATE_HOMES.join(', ')}].`);
    }

    let simple;
    try { simple = nbt.simplify(nbt.parseUncompressed(raw)); }
    catch (e) {
        return { found: true, alive: false, unreadable: true, reason: `${path.basename(file)} did not parse as NBT (${e.message})` };
    }

    const health = typeof simple.Health === 'number' ? simple.Health : null;
    // UNROUNDED, and that is the point. A body's Y fraction is the only record of WHAT it is standing on:
    // 65.0 is a full block, 65.125 is a composter's inner floor, 65.5 is a slab. Every other report in the
    // fleet floors the position before anyone sees it, which is why diagnosing a body trapped in a compost
    // bin took two rounds — the one number that named the block was rounded away at every step.
    const pos = Array.isArray(simple.Pos) && simple.Pos.length === 3
        ? { x: simple.Pos[0], y: simple.Pos[1], z: simple.Pos[2] }
        : null;
    if (health === null) return { found: true, alive: false, unreadable: true, reason: `${path.basename(file)} parsed but carries no Health field` };
    const where = pos ? ` at (${pos.x.toFixed(2)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(2)})` : ' — playerdata carries no Pos';
    return {
        found: true,
        alive: health > 0,
        health,
        pos,
        dimension: simple.Dimension ?? null,
        reason: health > 0
            ? `alive at ${health.toFixed(1)} hp, logged off${where}`
            : `playerdata holds a corpse (Health 0) — a login onto this never emits \`spawn\` — died${where}`,
    };
}

// ── The HQ audit ─────────────────────────────────────────────────────────────────────────────────────

// hqAudit(botId) → { ok, state, reason, buildCenter }.
//
// ABSENT is legal and is NOT a brick: corporate_headquarters treats a missing file as a genuine first run
// and starts empty, which is the same thing a standard test does every time. It is reported rather than
// passed over silently only because a continue that finds no HQ is almost certainly not the continue the
// operator meant — the world will carry forward and the memory of it will not.
function hqAudit(botId) {
    const file = path.join(HQ_DIR, `corporate_headquarters.${botId}.json`);
    if (!fs.existsSync(file)) {
        return { ok: true, state: 'absent', file, buildCenter: null,
            reason: 'no HQ file — legal (treated as a first run) but a continue with no memory of the world it is continuing is probably not what was meant' };
    }
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); }
    catch (e) { return { ok: false, state: 'unreadable', file, buildCenter: null, reason: `exists but could not be read (${e.code}: ${e.message})` }; }

    // The NUL-filled corpse a power cut leaves behind parses as neither JSON nor anything else, and it is
    // worth naming separately because its size looks perfectly healthy in a directory listing.
    if (raw.length === 0) return { ok: false, state: 'empty', file, buildCenter: null, reason: 'file is zero bytes — a write that never landed' };
    // The next line's zero byte is written as an ESCAPE, never as a literal NUL typed between the quotes.
    // A raw zero byte in the source makes this ENTIRE file read as binary to grep, ripgrep and every other
    // text tool — the module goes unsearchable to defend one line — and any editor that strips control
    // characters deletes the test while leaving a line that still looks correct.
    if (raw.includes('\u0000')) return { ok: false, state: 'nul-filled', file, buildCenter: null, reason: 'file contains NUL bytes — the signature of an interrupted write, not of valid JSON' };

    let hq;
    try { hq = JSON.parse(raw); }
    catch (e) { return { ok: false, state: 'malformed', file, buildCenter: null, reason: `present but not valid JSON (${e.message}) — the bot would throw on first HQ access rather than start empty` }; }

    if (!hq || typeof hq !== 'object' || Array.isArray(hq)) {
        return { ok: false, state: 'malformed', file, buildCenter: null, reason: 'parsed to something that is not an object' };
    }
    if (hq.schema !== HQ_SCHEMA) {
        return { ok: false, state: 'wrong-schema', file, buildCenter: null, reason: `schema is ${JSON.stringify(hq.schema)}, expected ${JSON.stringify(HQ_SCHEMA)}` };
    }

    // ANY locked centre, not the literal 'headframe' key: room keys carry an owner (`headframe|<owner>`)
    // so the old literal matched nothing. A revive wants somewhere safe to stand, and the first locked
    // structure in this bot's own HQ is that, whoever it belongs to.
    const rooms = hq.building_confrence_room || {};
    const spot = Object.values(rooms)
        .map(e => e && e.set_buildspot)
        .find(sb => sb && sb.build_center && typeof sb.build_center.x === 'number');
    const bc = spot && spot.build_center;
    const buildCenter = bc && typeof bc.x === 'number' ? bc : null;
    return {
        ok: true, state: 'valid', file, buildCenter,
        reason: buildCenter
            ? `valid, headframe sited at (${buildCenter.x},${buildCenter.y},${buildCenter.z})`
            : 'valid, but no headframe buildspot is locked yet — a revived bot stays where vanilla puts it',
    };
}

// ── The recovery cell ────────────────────────────────────────────────────────────────────────────────

// death_manager's tier 1, and the same arithmetic for the same reason: the anchor offset is READ from the
// blueprint rather than restated, so moving anchor 0 in the blueprint moves this cell with it. The +1 is
// the floor→feet offset an RCON `tp` needs, applied once here exactly as it is there.
//
// SAFETY IS NOT RE-DERIVED AND IS ALSO NOT INHERITED HERE — the difference from death_manager is worth
// stating plainly. It gets to lean on building_integrity having scanned anchor 0 against the live world;
// this runs before any client can scan anything, so it cannot make that check and does not pretend to.
// What it relies on instead is narrower and still true: the cell is a blueprint anchor's floor in a base
// the last run was standing in, and a body placed one block above a floor that turns out to be missing
// falls a short distance rather than into anything. A wrong guess here costs a fall; the alternative —
// leaving a corpse — costs the run.
//
// THE FLOOR CELL IS NOT DERIVED HERE. `body_recovery.anchorZeroPoint` owns that walk and death_manager
// asks it the same question, so a disagreement about where anchor 0 IS cannot arise between the two
// paths that recover a body (Law 16). What this function adds is the one thing that differs: FEET rather
// than floor, +1, because this caller teleports to it verbatim.
function anchorZeroFeet(buildCenter, blueprintName = 'headframe') {
    if (!buildCenter) return null;
    const floor = recovery.anchorZeroPoint(blueprintName, buildCenter);
    return floor ? { x: floor.x, y: floor.y + 1, z: floor.z } : null;
}

// ── The repair ───────────────────────────────────────────────────────────────────────────────────────

// A plain TCP probe, not a ping or an RCON call: the question is whether the GAME port will accept the
// revival client, and only that port answers it. RCON can be up while the game port is not.
function serverListening(port, timeoutMs = 2000) {
    const net = require('net');
    return new Promise(resolve => {
        const sock = net.createConnection({ host: '127.0.0.1', port });
        const done = v => { try { sock.destroy(); } catch (_) { /* already gone */ } resolve(v); };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
    });
}

// revive(botId, { at }) → { botId, connected, respawned, teleported, at, error }.
//
// Wears the bot's own username, so it may only run while that name is free — before `bots-up`, never
// beside it. A name already in use surfaces as a connection error rather than as a mysterious timeout,
// which is why the login failure is reported verbatim.
//
// `respawn: false` matches master_core deliberately: the packet must be sent HERE, once, and verified,
// rather than fired automatically by the library where nothing reads whether a body came back. That is
// death_manager's ACT 1 discipline, and the reason it is a discipline is that the two failures — the
// packet was refused, and the packet worked but the body arrived late — are indistinguishable to anything
// that only checks the send.
async function revive(botId, { at, host = 'localhost', port = 25565, version = '1.21.5' } = {}) {
    const mineflayer = require('mineflayer');
    const out = { botId, connected: false, respawned: false, teleported: false, at: at || null, error: null };
    let bot = null;

    try {
        bot = mineflayer.createBot({ host, port, username: botId, version, respawn: false });

        const connected = await new Promise(resolve => {
            const done = v => { clearTimeout(timer); resolve(v); };
            const timer = setTimeout(() => done({ ok: false, why: `no login within ${LOGIN_WAIT_MS}ms` }), LOGIN_WAIT_MS);
            bot.once('login', () => done({ ok: true }));
            bot.once('error', e => done({ ok: false, why: e.message }));
            bot.once('kicked', r => done({ ok: false, why: `kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}` }));
        });
        if (!connected.ok) { out.error = connected.why; return out; }
        out.connected = true;

        // ── THE TWO ACTS, RUN BY THE SHARED FILE ───────────────────────────────────────────────────
        // The offline playerdata read that got us here is a CLAIM, not a fact (Law 23): the file is the
        // state of the last clean save and anything could have touched the world since. `reviveBody`
        // senses the live body from the server before it clicks anything, which is both the Law 23 gate
        // and — for a client this freshly logged in — the difference between a click that writes a packet
        // and one that silently does nothing. That reasoning lives in body_recovery's header; it is a
        // property of the library, not of this caller, which is exactly why it is not written here.
        const revival = await recovery.reviveBody(bot);
        if (revival.healthUnknown) { out.error = `logged in but ${revival.why}`; return out; }
        if (revival.wasDead === false) {
            // The file said corpse and the world says otherwise. Reported rather than passed over: it
            // means something moved this bot between the save and now, which is worth knowing on a bench
            // whose whole premise is that the world was left untouched.
            out.respawned = true;
            out.alreadyAlive = true;
        } else if (!revival.revived) {
            out.error = revival.why;
            return out;
        } else {
            out.respawned = true;
        }

        if (!at) return out;

        const tp = await recovery.teleportTo(bot, at, { name: botId });
        if (!tp.moved) { out.error = tp.error; return out; }
        out.teleported = true;
        return out;
    } finally {
        // The name has to be free before bots-up wears it, so the disconnect is not optional and does not
        // get to depend on the outcome above (Law 8 — what this raised, this ends).
        try { if (bot) bot.quit(); } catch (_) { /* already gone */ }
        await sleep(1200);
    }
}

// ── The preflight ────────────────────────────────────────────────────────────────────────────────────

// preflight(botIds, { world, live }) → { ok, refusals, findings }.
//
// Machine-facing: it RETURNS a verdict and never exits the process, because its caller is a conductor that
// owns the teardown decision (monitoring/README's rule for lenses, and the same reasoning — a consumer
// wired to an instrument that exits cannot act on what it found).
//
// `live:false` audits and reports without touching the world, which is what makes this runnable as a plain
// question ("would a continue work right now?") rather than only as a side effect of starting one.
async function preflight(botIds, { world = null, live = true, blueprint = 'headframe', gamePort = 25565 } = {}) {
    world = world || currentWorld();
    const findings = [];
    const refusals = [];

    // The server check belongs to this preflight rather than to the conductor, because a continue's
    // dependence on an already-running server is a property of what continue MEANS: it carries a world
    // forward, and choosing which world to serve is the one decision it must never make. `bots-up` refuses
    // for the same reason further down the sequence; asked here, the refusal lands before anything is
    // raised (Law 8). Only checked on a live pass — an audit is a question about files and answers it
    // whether or not anything is serving them.
    const listening = live ? await serverListening(gamePort) : true;
    if (!listening) {
        refusals.push(`nothing is listening on ${gamePort} — a continue reuses the running server and will not `
            + `start one for you, because starting a server picks a WORLD and that is the one choice a continue `
            + `may not make silently. Run \`fleet_control.js server-start\` first.`);
        return { ok: false, refusals, findings };
    }

    for (const botId of botIds) {
        const hq = hqAudit(botId);
        const body = readBody(world, botId);
        const finding = { botId, hq, body, revival: null };

        if (!hq.ok) refusals.push(`${botId}: HQ ${hq.state} — ${hq.reason}`);
        if (body.unreadable) refusals.push(`${botId}: playerdata unreadable — ${body.reason}`);

        // A corpse is REPAIRED, not refused, and that asymmetry is the point of the whole file: an HQ this
        // cannot safely rebuild stops the run, a body it can safely rebuild does not.
        if (hq.ok && !body.unreadable && !body.alive && body.found) {
            if (!live) {
                finding.revival = { skipped: 'live:false — corpse found and left alone' };
            } else {
                const at = anchorZeroFeet(hq.buildCenter, blueprint);
                finding.revival = await revive(botId, { at });
                if (!finding.revival.respawned) {
                    refusals.push(`${botId}: DEAD and the revival failed — ${finding.revival.error}`);
                }
            }
        }
        findings.push(finding);
    }
    return { ok: refusals.length === 0, refusals, findings };
}

// render(result) → the human-facing lines. Separate from preflight for the reason the monitoring split
// names: the conductor consumes the RETURN, an operator reads this, and one function trying to do both
// ends up serving neither.
function render(result) {
    const lines = [];
    for (const f of result.findings) {
        lines.push(`  ${f.botId}`);
        lines.push(`    HQ    ${f.hq.state.padEnd(12)} ${f.hq.reason}`);
        lines.push(`    body  ${(f.body.alive ? 'alive' : 'DEAD').padEnd(12)} ${f.body.reason}`);
        if (f.revival) {
            if (f.revival.skipped) lines.push(`    revive  ${f.revival.skipped}`);
            else if (f.revival.respawned && f.revival.teleported) lines.push(`    revive  ${f.revival.alreadyAlive ? '· body was ALREADY ALIVE (the file read was stale)' : '✓ body back'} and standing at (${f.revival.at.x},${f.revival.at.y},${f.revival.at.z})`);
            else if (f.revival.respawned) lines.push(`    revive  ${f.revival.alreadyAlive ? '· body was ALREADY ALIVE (the file read was stale)' : '✓ body back'}${f.revival.error ? ` — but not moved: ${f.revival.error}` : ' — left where vanilla put it (no sited headframe)'}`);
            else lines.push(`    revive  ✗ ${f.revival.error}`);
        }
    }
    return lines;
}

module.exports = { preflight, render, hqAudit, readBody, revive, anchorZeroFeet, botUuid };

// CLI — the same question asked by hand. `--check` audits without touching the world.
if (require.main === module) {
    const argv = process.argv.slice(2);
    const flag = k => argv.includes(`--${k}`);
    const val = (k, d) => {
        const hit = argv.find(a => a.startsWith(`--${k}=`));
        return hit ? hit.slice(k.length + 3) : d;
    };
    const named = val('bots', null);
    const bots = named
        ? named.split(',').map(s => s.trim()).filter(Boolean)
        : roster(val('count', null) ? parseInt(val('count', null), 10) : null);
    const world = val('world', null) || currentWorld();
    preflight(bots, { world, live: !flag('check') })
        .then(res => {
            console.log(`\n${TAG} · ${bots.length} bot(s) · world '${world}'${flag('check') ? ' · CHECK ONLY (world untouched)' : ''}\n`);
            for (const l of render(res)) console.log(l);
            console.log(res.ok
                ? `\n✅ continue is safe to start.\n`
                : `\n⛔ REFUSED — nothing was raised:\n${res.refusals.map(r => `   · ${r}`).join('\n')}\n`);
            process.exit(res.ok ? 0 : 1);
        })
        .catch(e => { console.error(`${TAG}: ${e.message}`); process.exit(1); });
}
