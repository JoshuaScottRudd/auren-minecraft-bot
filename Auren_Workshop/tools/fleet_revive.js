// bench: fleet_revive — the two preflight questions a CONTINUE has to answer that a ROLLBACK never does.
//
// A rollback test restores a snapshot, so both questions are answered by construction: the HQ it starts
// from is whatever the snapshot carried, and every playerdata file in it holds a live body. A continue
// carries the last run's world and HQ forward, so it inherits whatever state the last run *ended* in —
// and a run can end at any instant, including the instant after a death.
//
// ── WHY THIS LIVES OUTSIDE BOT CODE ────────────────────────────────────────────
// death_manager owns death recovery under autonomy and is the right owner there, but cannot own it here:
// master_core runs `bot.once('spawn', ...)`, and a client that logs in onto a corpse never receives that
// event, so the fragment that would fix the corpse is inside the process the corpse prevents from
// initialising. Every operator verb sits on the far side of the same gate, `verb respawn` included, since
// the verb route needs master_core listening. A dead playerdata file is a fault in the world the fleet is
// about to be raised on, and the thing raising the fleet is the only party still able to act on it.
//
// What is reused is death_manager's SHAPE: two acts, each a command followed by a sense (a respawn packet
// accepted is not a body; an RCON `tp` that returned cleanly is not an arrival), and the same tier-1
// recovery cell derived from the same blueprint. Not reused: its tier-2/tier-3 scan machinery —
// `building_integrity.scan` and find_buildingspot both need a live bot with loaded chunks, which does not
// exist yet here. The conductor's job stops where death_manager's begins: get a live body standing
// somewhere sane, then hand over. Once master_core initialises, death_manager owns every death after this
// one.
//
// ── WHY DETECTION IS AN OFFLINE FILE READ AND REPAIR IS A CLIENT ─────────────────────────────────────
// The two halves have opposite costs. Detection runs for every bot on every continue, and the answer is
// already on disk: the server flushes playerdata on a clean stop, so `Health` in
// `<world>/playerdata/<uuid>.dat` is the state the next login will resume from, and reading it costs no
// connection. Repair only runs for a bot that is actually dead and genuinely requires a client, since a
// respawn is a packet only the client may send — the fleet can teleport a body as an operator, but cannot
// respawn one.
//
// That split has a hard ordering consequence: repair must run before `bots-up`, because a username may
// hold exactly one connection and the repair client wears the bot's own name. The conductor sequences it
// accordingly, and this file refuses if the name is already taken.
//
// ── WHY THE HQ AUDIT REFUSES INSTEAD OF REPAIRING ────────────────────────────────────────────────────
// corporate_headquarters already throws on a present-but-unreadable file, and that throw stays where it is
// — this is not a second opinion about the same question (Law 16). The difference is only WHEN it is
// asked. In-process, the throw fires after the fleet is raised, from inside one bot, three process layers
// below whoever asked for the run. Asked here, before anything is raised, the run refuses while there is
// still nothing to tear down (Law 8 — a conductor reaps only what it raised). It never rewrites an HQ it
// dislikes: the file holds the only copy of the transpose origin, the station map and every locked
// buildspot, and a wrong guess would destroy exactly what a continue exists to preserve. Default-stopped
// (Law 13) is the whole value here.

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/fleet_revive.js');

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Resolve prismarine-nbt/mineflayer by asking the one file that knows where modules live on this machine.
// Done here, not left to an inherited NODE_PATH: this file runs as a CHILD of the conductor, which spawns
// with a clean environment, so an unresolvable require would surface as "playerdata unreadable" — a
// refusal blaming the world for a fault in this file (Law 25).
//
// The resolver is asked, not restated (Law 16): a private list of "where do modules live" cannot stay in
// step with every machine layout, and the same private-copy defect once took down every verb the
// foreman's door could speak.
const paths = require('../workshop_paths');
const { bootstrapModulePath, CANDIDATE_HOMES } = require(paths.bot('js_kernel/utils/node_module_homes'));
const moduleDirs = bootstrapModulePath();
// The @-aliases, registered against Auren_Bot's own package.json: a bare `module-alias/register` walks up
// from the module's install dir and can land on a package.json with no _moduleAliases. Needed here because
// the recovery cell is read from blueprint_registry, which reaches for `@kernel/...` like every other file
// in the tree.
paths.registerAliases();

// The two acts of standing a body up, shared with death_manager and every other place a body is stood up.
// Required after the aliases, since it reaches `@kernel/blueprint_registry` for the recovery cell.
const recovery = require('@kernel/body_recovery');

const REPO_ROOT = paths.REPO_ROOT;
const SERVER_DIR = require(paths.bot('js_kernel/utils/workstation')).needServerDir();
const HQ_DIR = paths.bot('js_kernel');

const TAG = 'fleet_revive';
const HQ_SCHEMA = 'auren.corporate_headquarters.v1';
// Only the LOGIN wait is this file's own: the one act body_recovery does not own, since only this caller
// builds a client at all (a corpse never reaches master_core, so the in-process path cannot exist here).
// Every window after the login is body_recovery's.
const LOGIN_WAIT_MS = 20000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The world's own records ──────────────────────────────────────────────────────────────────────────

// The roster is resolved here from its one declaration, so a caller only has to know how MANY bots it is
// raising. fleet_control derives its own the same way from the same constant (Law 16).
function roster(count = null) {
    const { BOT_SENIORITY } = require(paths.bot('Thinking_fragments/architect_config.js'));
    const all = Object.keys(BOT_SENIORITY).sort((a, b) => BOT_SENIORITY[a] - BOT_SENIORITY[b]);
    return count == null ? all : all.slice(0, Math.min(count, all.length));
}

// The world is READ from server.properties, never passed in with a default: a continue runs on whatever
// world the server is actually serving, and an assumed name would audit one world's playerdata while the
// fleet was raised on another's. rcon_link owns the properties read (Law 16).
function currentWorld() {
    const { readServerProperties } = require(paths.bot('js_kernel/utils/rcon_link'));
    const name = readServerProperties().level;
    if (!name) throw new Error(`[${TAG}] server.properties carries no level-name, so there is no way to know which world a continue would run on.`);
    return name;
}

// The name→uuid map is the SERVER's, not ours: deriving the offline-mode uuid independently would be a
// second implementation of a mapping the server already publishes (Law 16).
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
// `found:false` is not a failure: a bot that has never joined this world has no playerdata, and vanilla
// places it at world spawn alive. Naming that case apart from a dead body is the point of returning a
// reason (Law 25).
function readBody(world, botId) {
    const uuid = botUuid(botId);
    if (!uuid) return { found: false, alive: true, reason: `no usercache entry for ${botId} — it has never joined this server, so it will spawn fresh and alive` };
    const file = path.join(SERVER_DIR, world, 'playerdata', `${uuid}.dat`);
    if (!fs.existsSync(file)) return { found: false, alive: true, reason: `no playerdata for ${botId} in '${world}' — first join on this world, spawns fresh and alive` };

    let raw = fs.readFileSync(file);
    // Vanilla gzips playerdata, but the format permits it uncompressed and a hand-edited file often is.
    // Sniffing the magic means a legitimate uncompressed file reads instead of throwing a zlib error that
    // looks like corruption.
    if (raw[0] === 0x1f && raw[1] === 0x8b) {
        try { raw = zlib.gunzipSync(raw); }
        catch (e) { return { found: true, alive: false, unreadable: true, reason: `${path.basename(file)} is gzipped but would not inflate (${e.message}) — treat as corrupt, not as dead` }; }
    }

    // The LOAD and the PARSE are separated: they are different classes of fault and only one is about the
    // world. A missing prismarine-nbt cannot happen in a correctly-installed tree, so it throws (Law 13),
    // never reported as "playerdata unreadable" for a fault in this file itself.
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
    // fleet floors the position before anyone sees it.
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

// hqAudit(botId) → { ok, state, reason, transposeOrigin }.
//
// ABSENT is legal and is not a brick: corporate_headquarters treats a missing file as a genuine first run
// and starts empty. It is reported, since a continue that finds no HQ is almost certainly not the
// continue the operator meant.
function hqAudit(botId) {
    const file = path.join(HQ_DIR, `corporate_headquarters.${botId}.json`);
    if (!fs.existsSync(file)) {
        return { ok: true, state: 'absent', file, transposeOrigin: null,
            reason: 'no HQ file — legal (treated as a first run) but a continue with no memory of the world it is continuing is probably not what was meant' };
    }
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); }
    catch (e) { return { ok: false, state: 'unreadable', file, transposeOrigin: null, reason: `exists but could not be read (${e.code}: ${e.message})` }; }

    // The NUL-filled corpse a power cut leaves behind parses as neither JSON nor anything else, worth
    // naming separately since its size looks healthy in a directory listing.
    if (raw.length === 0) return { ok: false, state: 'empty', file, transposeOrigin: null, reason: 'file is zero bytes — a write that never landed' };
    // The next line's zero byte is written as an ESCAPE, never a literal NUL between the quotes: a raw
    // zero byte in the source would make this ENTIRE file read as binary to grep and every other text
    // tool, and an editor that strips control characters would delete the test while the line still looks
    // correct.
    if (raw.includes('\u0000')) return { ok: false, state: 'nul-filled', file, transposeOrigin: null, reason: 'file contains NUL bytes — the signature of an interrupted write, not of valid JSON' };

    let hq;
    try { hq = JSON.parse(raw); }
    catch (e) { return { ok: false, state: 'malformed', file, transposeOrigin: null, reason: `present but not valid JSON (${e.message}) — the bot would throw on first HQ access rather than start empty` }; }

    if (!hq || typeof hq !== 'object' || Array.isArray(hq)) {
        return { ok: false, state: 'malformed', file, transposeOrigin: null, reason: 'parsed to something that is not an object' };
    }
    if (hq.schema !== HQ_SCHEMA) {
        return { ok: false, state: 'wrong-schema', file, transposeOrigin: null, reason: `schema is ${JSON.stringify(hq.schema)}, expected ${JSON.stringify(HQ_SCHEMA)}` };
    }

    // ANY locked centre, not the literal 'headframe' key: room keys carry an owner (`headframe|<owner>`).
    // A revive wants somewhere safe to stand, and the first locked structure in this bot's own HQ is that,
    // whoever it belongs to.
    const rooms = hq.building_confrence_room || {};
    const spot = Object.values(rooms)
        .map(e => e && e.set_buildspot)
        .find(sb => sb && sb.transpose_origin && typeof sb.transpose_origin.x === 'number');
    const bc = spot && spot.transpose_origin;
    const transposeOrigin = bc && typeof bc.x === 'number' ? bc : null;
    return {
        ok: true, state: 'valid', file, transposeOrigin,
        reason: transposeOrigin
            ? `valid, headframe sited at (${transposeOrigin.x},${transposeOrigin.y},${transposeOrigin.z})`
            : 'valid, but no headframe buildspot is locked yet — a revived bot stays where vanilla puts it',
    };
}

// ── The recovery cell ────────────────────────────────────────────────────────────────────────────────

// death_manager's tier 1, and the same arithmetic for the same reason: the anchor offset is READ from the
// blueprint, never restated, so moving anchor 0 in the blueprint moves this cell with it. The +1 is the
// floor→feet offset an RCON `tp` needs, applied once here exactly as it is there.
//
// SAFETY IS NOT RE-DERIVED AND IS NOT INHERITED HERE. death_manager leans on building_integrity having
// scanned anchor 0 against the live world; this runs before any client can scan anything, so it makes no
// such claim. What it relies on instead: the cell is a blueprint anchor's floor in a base the last run was
// standing in, and a body placed one block above a floor that turns out missing falls a short distance. A
// wrong guess here costs a fall; leaving a corpse costs the run.
//
// THE FLOOR CELL IS NOT DERIVED HERE. `body_recovery.anchorZeroPoint` owns that walk and death_manager
// asks it the same question, so the two paths that recover a body cannot disagree about where anchor 0 is
// (Law 16). What this function adds is the one thing that differs: FEET, not floor, +1, because this
// caller teleports to it verbatim.
function anchorZeroFeet(transposeOrigin, blueprintName = 'headframe') {
    if (!transposeOrigin) return null;
    const floor = recovery.anchorZeroPoint(blueprintName, transposeOrigin);
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
// beside it. A name already in use surfaces as a connection error, reported verbatim.
//
// `respawn: false` matches master_core: the packet is sent here, once, and verified — death_manager's ACT
// 1 discipline — so a refused packet and a late-arriving body stay distinguishable, which checking only
// the send cannot do.
// The three connection defaults are READ from the one page that owns them, never restated (Law 16), so a
// protocol change updates this path along with everywhere else. Named parameters stay, since a probe
// pointed elsewhere still needs them.
async function revive(botId, { at, host, port, version } = {}) {
    const cfg = require(paths.bot('Thinking_fragments/architect_config.js'));
    host = host ?? cfg.SERVER_ENDPOINT.host;
    port = port ?? cfg.SERVER_ENDPOINT.port;
    version = version ?? cfg.SERVER_MINECRAFT_VERSION;
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
        // senses the live body from the server before it clicks anything, which is the Law 23 gate and,
        // for a client this freshly logged in, the difference between a click that writes a packet and
        // one that silently does nothing. That reasoning lives in body_recovery's header.
        const revival = await recovery.reviveBody(bot);
        if (revival.healthUnknown) { out.error = `logged in but ${revival.why}`; return out; }
        if (revival.wasDead === false) {
            // The file said corpse and the world says otherwise. Reported, not passed over: it means
            // something moved this bot between the save and now, worth knowing on a bench whose premise
            // is that the world was left untouched.
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
// Machine-facing: it RETURNS a verdict and never exits the process, since its caller is a conductor that
// owns the teardown decision (monitoring/README's rule for lenses).
//
// `live:false` audits and reports without touching the world, which makes this runnable as a plain
// question about whether a continue would work right now.
async function preflight(botIds, { world = null, live = true, blueprint = 'headframe', gamePort = 25565 } = {}) {
    world = world || currentWorld();
    const findings = [];
    const refusals = [];

    // The server check belongs to this preflight, not the conductor: a continue's dependence on an
    // already-running server is a property of what continue MEANS — it carries a world forward, and
    // choosing which world to serve is the one decision it must never make. Asked here, the refusal lands
    // before anything is raised (Law 8). Only checked on a live pass: an audit is a question about files
    // and answers it whether or not anything is serving them.
    const listening = live ? await serverListening(gamePort) : true;
    if (!listening) {
        refusals.push(`nothing is listening on ${gamePort} — a continue reuses the running server and will not `
            + `start one for you, because starting a server picks a WORLD and that is the one choice a continue `
            + `may not make silently. Start it first: node start_auren.js --start continue --crew contractor --soak 0`);
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
                const at = anchorZeroFeet(hq.transposeOrigin, blueprint);
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
