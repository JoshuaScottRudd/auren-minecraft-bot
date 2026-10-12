// Auren_Bot/monitoring/progress_tracker.js
// A read-only observer of corporate HQ — answers what the bots have completed, standing and cumulative.
// trace_monitor reads the trace (watcher_*.json), which `up` wipes every run, so it only ever sees the
// current run segment. Durable "what stands" lives in corporate_headquarters*.json (HQ), untouched by a
// start and cleared only by an explicit flush; this tool reads that.
//
// Purely an observer: it never writes HQ, never alters it, and derives nothing back into it. HQ is
// machine-to-machine state; any human-facing gloss computed here stays in memory and is only printed
// (Law 6: it owns no HQ section; Law 23/19: an observer that edits the record to ease its own job is no
// longer one). Like trace_monitor it lives outside the construct — not a fragment, no signal bus, decides
// nothing in the SPA loop, and touches no bot.
//
// No live voxel percentage: a running voxel count exists only in the trace, never persisted to HQ. HQ
// carries a binary `all_complete` plus the exact `materials_missing`, so this stays coupled to HQ alone
// (Law 16).
//
// Each bot writes its own corporate_headquarters.<BotId>.json, a full mirror of shared HQ plus its own
// boardroom chair. Shared rooms (structures, job board, logistics, mining, exploration) are read from the
// freshest file by `updated_at`, for a coherent foreman-synced snapshot. Each bot's "doing now" is read
// from that bot's own file, which is authoritative for itself (Law 23). Only bots present in the freshest
// boardroom are shown, so a stale file left on disk from a smaller run never surfaces.
//
// Usage:  node progress_tracker.js                                (full snapshot)
//         .\Auren_Bot\Auren_Workshop\scripts\progress.ps1          (wrapper; from the repo root)
//         .\Auren_Workshop\scripts\progress.ps1                    (same, from a download's Auren_Bot root)
// Exit codes: 0 rendered · 1 no readable HQ found.

'use strict';
require('../js_kernel/utils/developer_door').enter('monitoring/progress_tracker.js');

const fs = require('fs');
const path = require('path');
const out = require('./data_out');

const HQ_DIR = require('./lens_paths').bot('js_kernel');
const HQ_RE = /^corporate_headquarters\.(.+)\.json$/;

// ── Load every per-bot HQ mirror on disk ─────────────────────────────────────
function loadHqFiles() {
  let names;
  try { names = fs.readdirSync(HQ_DIR); }
  catch { return []; }
  // Named `mirrors`, not `out` — `out` is the data_out writer at module scope, and a local array of
  // that name would shadow it.
  const mirrors = [];
  for (const name of names) {
    const m = name.match(HQ_RE);
    if (!m) continue;
    const full = path.join(HQ_DIR, name);
    let data;
    try { data = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch { continue; } // a half-written file mid-flush parses next tick; skip, never guess (Law 13)
    mirrors.push({ botId: m[1], data, updatedAt: Date.parse(data.updated_at) || 0 });
  }
  return mirrors;
}

// ── Small formatters ─────────────────────────────────────────────────────────
// An elapsed span, and nothing else; the unit lives in the field name (`hq_updated_ago`). An unreadable
// stamp returns null so data_out prints its absent mark, never a word the reader could mistake for
// something HQ wrote.
const ago = ms => {
  if (!ms) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
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
    // Room keys carry an owner (e.g. `headframe|<player>`); the label shows the structure, the key stays the id.
    const displayName = name.includes('|') ? name.slice(0, name.lastIndexOf('|')) : name;
    const it = integrityOf(s);
    const vox = s.blueprint_paster && s.blueprint_paster.total_voxels;
    const locked = s.set_buildspot && s.set_buildspot.locked_at ? 'locked' : 'unlocked';
    const complete = !!(it && (it.all_complete || it.structure_complete));
    const missing = it ? items(it.materials_missing) : '';
    const need = it ? items(it.materials_needed) : '';
    // State is a token and materials are their own field, so no reader needs to split a composed
    // sentence to use either half.
    const state = complete ? 'complete' : missing ? 'short' : need ? 'needs' : 'building';
    return { name: displayName, vox: vox != null ? vox : null, locked, complete, state,
      materials: missing || need || null };
  });
  const done = structItems.filter(s => s.complete).length;

  // What each bot is doing now — read from its OWN freshest file (Law 23), not the stale shared mirror.
  const bots = botIds.map(id => {
    const self = (ownFile[id] && ownFile[id].data.bot_boardroom && ownFile[id].data.bot_boardroom[id]) || boardroom[id];
    const mag = self && self.magnet;
    // The task is fields, not a status line. `doing` is HQ's own `type/what` token; `need` is the amount
    // still to obtain and `batch` is a batch size, kept as separate fields.
    const doing = mag ? `${mag.type}/${mag.what}` : null;
    return {
      id,
      doing,
      need: mag && mag.need != null ? mag.need : null,
      batch: mag && mag.batch_quantity != null ? mag.batch_quantity : null,
      where: mag && mag.where ? `${mag.where.x},${mag.where.y},${mag.where.z}` : null,
    };
  });

  const jobs = (hq.job_board_room && hq.job_board_room.jobs) || [];
  // The board's own coordinates — the only rendering there is. A pre-band job carries no stage by design
  // and renders as its band alone.
  const queue = {
    count: jobs.length,
    list: jobs.map(j => `[${j.asker && j.stage ? `${j.asker}/${j.stage}` : (j.asker ?? '?')}] ${j.type}/${j.what}`).join(' · '),
  };

  // Each site fact is a named field and a value, never a composed phrase a reader must parse.
  const site = [];
  const segs = hq.mining_confrence_room && hq.mining_confrence_room.built_segments;
  if (segs) site.push({ fact: 'shaft_segments_built', value: Object.keys(segs).length });
  // Cells are the fractal mining rooms fanned off the shaft. The `cells` registry includes complete:false
  // neighbours the frontier has grown but not dug; only complete cells are counted.
  const cells = hq.mining_confrence_room && hq.mining_confrence_room.cells;
  if (cells) site.push({ fact: 'mining_cells_built', value: Object.values(cells).filter(c => c && c.complete).length });
  const seeker = hq.exploration_confrence_room && hq.exploration_confrence_room.biome_seeker;
  if (seeker) {
    site.push({ fact: 'biome_current', value: seeker.current_biome });
    site.push({ fact: 'biome_target', value: seeker.target_biome });
    if (seeker.target_distance != null) site.push({ fact: 'biome_target_distance', value: seeker.target_distance });
  }
  const stations = hq.logistics_confrence_room && hq.logistics_confrence_room.stations;
  if (stations) {
    site.push({ fact: 'stations', value: Object.keys(stations).length });
    site.push({ fact: 'stations_chest', value: Object.values(stations).filter(s => s.type === 'chest').length });
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
// Output is data, not prose: field names and values only, with spacing and columns owned by data_out.
// Strings reaching a value cell are copied — a structure name, a bot id, a job coordinate, a material
// list — never composed by this observer.
function render(files) {
  const snap = computeSnapshot(files);

  out.kv('lens', 'progress_tracker');
  out.kv('source', 'corporate_headquarters');
  out.kv('bots', snap.bots.length);
  out.kv('hq_updated_ago', ago(snap.updatedAt));

  // Structures: the standing what's-built ledger. `state` and `materials` arrive already separate from
  // computeSnapshot, so each reader (this lens and dashboard.js) takes the field it wants.
  out.section('structures');
  out.kv('structures_complete', snap.structures.done);
  out.kv('structures_total', snap.structures.total);
  if (snap.structures.total) {
    out.table(['structure', 'complete', 'voxels', 'buildspot', 'state', 'materials'],
      snap.structures.items.map(s => [s.name, s.complete, s.vox, s.locked, s.state, s.materials]));
  }

  // BOTS — what each is doing right now. `doing` is HQ's own magnet coordinates, copied whole.
  out.section('bots_doing_now');
  out.table(['bot', 'doing', 'need', 'batch', 'where'],
    snap.bots.map(b => [b.id, b.doing, b.need, b.batch, b.where]));

  // QUEUE — outstanding jobs not yet finished. The board's own `[asker/stage] type/what` coordinates.
  out.section('queue');
  out.kv('jobs', snap.queue.count);
  if (snap.queue.count) out.list('job', snap.queue.list.split(' · '));

  // SITE — supporting standing state (mining, exploration, logistics), each already a named fact and a
  // value from computeSnapshot.
  if (snap.site.length) {
    out.section('site');
    out.table(['fact', 'value'], snap.site.map(s => [s.fact, s.value]));
  } else {
    out.zero('site_facts');
  }
}

// ── Main (CLI only; guarded so monitoring/dashboard.js can require the readers inert) ──
if (require.main === module) {
  const files = loadHqFiles();
  if (!files.length) {
    console.error('progress_tracker: no readable corporate_headquarters.*.json in ' + HQ_DIR);
    process.exit(1);
  }
  // render writes every field through data_out; there is nothing left for this line to print.
  render(files);
  process.exit(0);
}

module.exports = { loadHqFiles, computeSnapshot };
