// Auren_Bot/monitoring/progress_tracker.js
// A read-only OBSERVER of corporate HQ — answers the one question trace_monitor structurally
// cannot: "what have the bots completed, standing and cumulative?" trace_monitor reads the
// trace (watcher_*.json), which `up` WIPES every run, so it only ever sees the current run
// segment. Durable "what stands" lives in corporate_headquarters*.json (HQ) — untouched by a
// start, cleared only by an explicit flush. This tool reads THAT.
//
// PURELY AN OBSERVER (Architect, 2026-07-14): it never writes HQ, never alters it, and derives
// nothing back into it. HQ is machine-to-machine state; a percentage or any human-facing gloss
// computed here stays in memory and is printed — writing it back would contaminate HQ with an
// observer's convenience and give the tool a stake in the data it watches (Law 6: it owns no HQ
// section; Law 23/19: an observer that edits the record to ease its own job is no longer one).
// Like trace_monitor it lives OUTSIDE the construct — not a fragment, no signal bus, decides
// nothing in the SPA loop. Touches no bot.
//
// WHY no live voxel %: the "283/285 correct" count is a world-scan that exists only in the
// trace, never persisted to HQ. HQ instead carries a binary `all_complete` plus the exact
// `materials_missing` — a cleaner "done, or here's precisely what's left" than a bar that
// flickers ±2 mid-build. Reading the live count would mean reading the trace too, re-coupling
// this observer to trace_monitor's source (Law 16) — deliberately not done.
//
// WHICH HQ file: each bot writes its OWN corporate_headquarters.<BotId>.json, a full mirror of
// shared HQ plus its own boardroom chair. Shared rooms (structures, job board, logistics, mining,
// exploration) are read from the FRESHEST file by `updated_at` — a coherent overseer-synced
// snapshot. Each bot's "doing now" is read from that bot's OWN file, which is authoritative and
// freshest for itself (Law 23 — verify against the freshest source, don't trust a stale mirror).
// Only bots present in the freshest boardroom are shown, so a run of N bots never surfaces a
// stale TestBot file left on disk.
//
// Usage:  node progress_tracker.js            (full snapshot)
//         .\Auren_Bot\Auren_Workshop\scripts\progress.ps1   (wrapper; from the Architect's repo root)
//         .\Auren_Workshop\scripts\progress.ps1             (same, from a download's Auren_Bot root)
// Exit codes: 0 rendered · 1 no readable HQ found.

'use strict';

const fs = require('fs');
const path = require('path');

const HQ_DIR = require('./lens_paths').bot('js_kernel');
const HQ_RE = /^corporate_headquarters\.(.+)\.json$/;

// ── Load every per-bot HQ mirror on disk ─────────────────────────────────────
function loadHqFiles() {
  let names;
  try { names = fs.readdirSync(HQ_DIR); }
  catch { return []; }
  const out = [];
  for (const name of names) {
    const m = name.match(HQ_RE);
    if (!m) continue;
    const full = path.join(HQ_DIR, name);
    let data;
    try { data = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch { continue; } // a half-written file mid-flush parses next tick; skip, never guess (Law 13)
    out.push({ botId: m[1], data, updatedAt: Date.parse(data.updated_at) || 0 });
  }
  return out;
}

// ── Small formatters ─────────────────────────────────────────────────────────
const ago = ms => {
  if (!ms) return 'unknown';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
};
// {planks:64, chest:4} -> "planks×64, chest×4"; {} -> ''
const items = obj => Object.entries(obj || {}).map(([k, v]) => `${k}×${v}`).join(', ');

// Each structure carries exactly one integrity sub-object whose key ends in "_integrity"
// (building_integrity / farming_integrity). Normalize across them.
function integrityOf(structure) {
  const key = Object.keys(structure).find(k => k.endsWith('_integrity'));
  return key ? structure[key] : null;
}

// ── Compute one snapshot (structured, no formatting) ──────────────────────────
// The single HQ→structured-state derivation (Law 16). render() below is one formatter over it (the CLI
// snapshot); monitoring/dashboard.js is a second (the live merged panel). Neither re-reads HQ's shape.
function computeSnapshot(files) {
  // Freshest file drives the shared rooms; index every bot's own file for self-reads.
  const canonical = files.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  const ownFile = Object.fromEntries(files.map(f => [f.botId, f]));
  const hq = canonical.data;

  const boardroom = hq.bot_boardroom || {};
  const botIds = Object.keys(boardroom); // scopes to the live fleet, not stale files on disk
  const structuresRaw = hq.building_confrence_room || {};
  const structNames = Object.keys(structuresRaw);

  const structItems = structNames.map(name => {
    const s = structuresRaw[name];
    // Room keys carry an owner (`headframe|Joshua`); the label shows the structure, the key stays the id.
    const displayName = name.includes('|') ? name.slice(0, name.lastIndexOf('|')) : name;
    const it = integrityOf(s);
    const vox = s.blueprint_paster && s.blueprint_paster.total_voxels;
    const locked = s.set_buildspot && s.set_buildspot.locked_at ? 'locked' : 'unlocked';
    const complete = !!(it && (it.all_complete || it.structure_complete));
    const missing = it ? items(it.materials_missing) : '';
    const need = it ? items(it.materials_needed) : '';
    let state;
    if (complete) state = 'COMPLETE';
    else if (missing) state = `building — short: ${missing}`;
    else if (need) state = `building — needs: ${need}`;
    else state = 'building';
    return { name: displayName, vox: vox != null ? vox : null, locked, complete, state, mark: complete ? '✅' : '⋯' };
  });
  const done = structItems.filter(s => s.complete).length;

  // What each bot is doing now — read from its OWN freshest file (Law 23), not the stale shared mirror.
  const bots = botIds.map(id => {
    const self = (ownFile[id] && ownFile[id].data.bot_boardroom && ownFile[id].data.bot_boardroom[id]) || boardroom[id];
    const mag = self && self.magnet;
    let doing = 'idle';
    if (mag) {
      // A single at-a-glance number per bot, so this quotes `need` — the amount still to obtain — rather
      // than a fraction. The old `have/target` form read as one ratio across two containers (job_board,
      // THE QUANTITY CONTRACT); a status line has no room to say which, so it states one honest figure.
      const qty = mag.need != null ? ` need ${mag.need}`
                : mag.batch_quantity != null ? ` batch ${mag.batch_quantity}`
                : '';
      const where = mag.where ? ` @ (${mag.where.x},${mag.where.y},${mag.where.z})` : '';
      doing = `${mag.type}/${mag.what}${qty}${where}`;
    }
    return { id, doing };
  });

  const jobs = (hq.job_board_room && hq.job_board_room.jobs) || [];
  // The board's own coordinates — the only rendering there is. A pre-band job carries no stage by design
  // and renders as its band alone.
  const queue = {
    count: jobs.length,
    list: jobs.map(j => `[${j.asker && j.stage ? `${j.asker}/${j.stage}` : (j.asker ?? '?')}] ${j.type}/${j.what}`).join(' · '),
  };

  const site = [];
  const segs = hq.mining_confrence_room && hq.mining_confrence_room.built_segments;
  if (segs) site.push(`shaft: ${Object.keys(segs).length} segment(s) built`);
  // Cells are the fractal mining rooms fanned off the shaft. The `cells` registry holds EVERY
  // registered cell — including complete:false neighbours the frontier grew but hasn't dug yet —
  // so count only complete ones; Object.keys would over-report unbuilt frontier as "built".
  const cells = hq.mining_confrence_room && hq.mining_confrence_room.cells;
  if (cells) site.push(`cells: ${Object.values(cells).filter(c => c && c.complete).length} built`);
  const seeker = hq.exploration_confrence_room && hq.exploration_confrence_room.biome_seeker;
  if (seeker) {
    const d = seeker.target_distance != null ? ` (${seeker.target_distance} away)` : '';
    site.push(`biome: ${seeker.current_biome} → ${seeker.target_biome}${d}`);
  }
  const stations = hq.logistics_confrence_room && hq.logistics_confrence_room.stations;
  if (stations) {
    const chests = Object.values(stations).filter(s => s.type === 'chest').length;
    site.push(`stations: ${Object.keys(stations).length} (${chests} chest)`);
  }

  return {
    updatedAt: canonical.updatedAt,
    bots,
    structures: { done, total: structNames.length, items: structItems },
    queue,
    site,
  };
}

// ── Render one snapshot (the CLI formatter over computeSnapshot) ──────────────
function render(files) {
  const snap = computeSnapshot(files);
  const out = [];
  out.push(`progress_tracker · corporate HQ snapshot · ${snap.bots.length} bot(s) · updated ${ago(snap.updatedAt)}`);
  out.push('(read-only observer of HQ — never writes, never alters, touches no bot)');
  out.push('');

  // STRUCTURES — the standing "what's built" ledger
  out.push(`STRUCTURES  (${snap.structures.done}/${snap.structures.total} complete)`);
  if (!snap.structures.total) out.push('  (none locked yet)');
  for (const s of snap.structures.items) {
    out.push(`  ${s.mark} ${s.name}`);
    out.push(`       ${s.vox != null ? s.vox + ' vox · ' : ''}${s.locked} · ${s.state}`);
  }
  out.push('');

  // BOTS — what each is doing right now
  out.push('BOTS  (doing now)');
  for (const b of snap.bots) out.push(`  ${b.id.padEnd(9)} ${b.doing}`);
  out.push('');

  // QUEUE — outstanding jobs not yet finished
  out.push(`QUEUE  (${snap.queue.count} job(s))`);
  if (snap.queue.count) out.push('  ' + snap.queue.list);
  out.push('');

  // SITE — supporting standing state (mining, exploration, logistics)
  if (snap.site.length) { out.push('SITE'); out.push('  ' + snap.site.join(' · ')); }

  return out.join('\n');
}

// ── Main (CLI only; guarded so monitoring/dashboard.js can require the readers inert) ──
if (require.main === module) {
  const files = loadHqFiles();
  if (!files.length) {
    console.error('progress_tracker: no readable corporate_headquarters.*.json in ' + HQ_DIR +
      ' — is the fleet up and past a first HQ write?');
    process.exit(1);
  }
  console.log(render(files));
  process.exit(0);
}

module.exports = { loadHqFiles, computeSnapshot };
