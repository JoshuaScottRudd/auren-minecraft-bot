// Auren_Bot/monitoring/foreman_lens.js
// THE FOREMAN'S RUN, READ BACK — the beats it said to the world, and every crew raise it withheld.
//
// Reads the foreman's own record in the records room, decoded through `custom_api/crew_log.parseAll` — the
// SAME module the foreman emits through — and the verbatim text through `foreman/foreman_record.decodeText`,
// the same file that encoded it. No regex of its own for either (Law 26 — both ends of the interface, or
// neither; Law 16 — one implementation).
//
// The foreman's file holds exactly one run: every run start flushes `watcher_*.jsonl` wholesale, so
// there is no run boundary to segment on.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --foreman

'use strict';

const path = require('path');

// Registers @-aliased require paths through the workshop's one answer (Law 16); idempotent, so safe
// whether or not a caller already registered them.
const paths = require('./lens_paths');
paths.registerAliases();
const crewLog = require('@api/crew_log');

const { readForemanView } = require('./trace_read');
// The one writer to stdout: data_out owns every space and every column width.
const out = require('./data_out');
// The decoder from the encoder's own file. Requiring the foreman's module from the monitoring side is the
// dependency running the legal direction — a reader may read the thing it reads; the foreman must never
// require a lens (monitoring/README's one-way rule).
const { decodeText, TAG } = require(paths.bot('foreman/foreman_record'));

// The records room, asked of the one module that answers it — never spelled here (Law 16).
const recordHomes = require(paths.bot('js_kernel/utils/record_homes'));
const TRACE_DIR = recordHomes.TRACE_DIR;

// ── READING ──────────────────────────────────────────────────────────────────────────────────────
// recordEvents(lines) → [{ at, verb, fields }]. A line without a readable stamp is SKIPPED, not defaulted:
// every ordering below is on that clock, and a zero would sort an event to the head of the run (Law 13 —
// never default a missing field).
function recordEvents(lines) {
  const events = [];
  for (const l of lines) {
    if (!l.iso) continue;
    const at = Date.parse(l.iso);
    if (Number.isNaN(at)) continue;
    for (const ev of crewLog.parseAll(l.raw)) {
      if (ev.tag !== TAG) continue;
      events.push({ at, verb: ev.verb, fields: ev.fields });
    }
  }
  return events;
}

// announcements(lines) → [{ at, kind, structure, layer, of, text }] in the order said. `kind` is
// 'structure' (a structure finished) or 'layer' (a layer released); the fields the other kind does not
// carry are null. The run's milestones, which a timelapse cuts on.
function announcements(lines) {
  return recordEvents(lines)
    .filter(e => e.verb === 'announced')
    .map(e => ({
      at: e.at,
      kind: e.fields.kind,
      structure: e.fields.structure || null,
      layer: e.fields.layer == null ? null : Number(e.fields.layer),
      of: e.fields.of == null ? null : Number(e.fields.of),
      text: decodeText(e.fields.text),
    }));
}

// refusals(lines) → [{ at, code, detail }] in the order withheld.
function refusals(lines) {
  return recordEvents(lines)
    .filter(e => e.verb === 'refused')
    .map(e => ({ at: e.at, code: e.fields.code, detail: decodeText(e.fields.detail) }));
}

// keeperFields(lines) → [{ at, room, held, growing, mature, untilled, unsown, blocked, stranded }]: the integrity keeper's
// fields verdict (foreman/integrity_keeper_worker), one row per field per reading it logged; it logs on a change.
const KEEPER_FIELDS_RE = /integrity keeper: fields: (.*)$/;
const FIELD_RE = /^(\S+) (?:(not held)|(\d+) growing, (\d+) mature, (\d+) untilled, (\d+) unsown, (\d+) blocked(, STRANDED)?)$/;
function keeperFields(lines) {
  const rows = [];
  for (const l of lines) {
    const m = KEEPER_FIELDS_RE.exec(l.raw || '');
    if (!m || !l.iso) continue;
    for (const part of m[1].split('; ')) {
      const f = FIELD_RE.exec(part.trim());
      if (!f) continue;
      rows.push({ at: Date.parse(l.iso), room: f[1], held: !f[2], growing: f[3] ?? null, mature: f[4] ?? null,
        untilled: f[5] ?? null, unsown: f[6] ?? null, blocked: f[7] ?? null, stranded: f[2] ? null : !!f[8] });
    }
  }
  return rows;
}

// keeperPlans(lines) → [{ at, base_torches, mine_torches, structures, columns }]: each plans reading the integrity
// keeper's thread logged, with the chunk columns it asked the foreman's body for.
const KEEPER_PLANS_RE = /integrity keeper: plans read: (\d+) base torch\(es\), (\d+) mine torch\(es\) on their designs, (\d+) sited structure\(s\), (\d+) column\(s\) asked for/;
function keeperPlans(lines) {
  const rows = [];
  for (const l of lines) {
    const m = KEEPER_PLANS_RE.exec(l.raw || '');
    if (!m || !l.iso) continue;
    const [base_torches, mine_torches, structures, columns] = m.slice(1).map(Number);
    rows.push({ at: Date.parse(l.iso), base_torches, mine_torches, structures, columns });
  }
  return rows;
}

// keeperNursery(lines) → [{ at, standing, stalks, ripe, tiles, piers, unheld, columns }]: the integrity keeper's cane
// nursery readings (foreman/nursery_keeper), one per change in standing cane, open tiles or pier cells.
const KEEPER_NURSERY_RE = /integrity keeper: nursery: (\d+) cane standing in (\d+) stalk\(s\) \((\d+) ripe\), (\d+) open tile\(s\), (\d+) pier cell\(s\), (\d+) of (\d+) column\(s\) unheld/;
function keeperNursery(lines) {
  const rows = [];
  for (const l of lines) {
    const m = KEEPER_NURSERY_RE.exec(l.raw || '');
    if (!m || !l.iso) continue;
    const [standing, stalks, ripe, tiles, piers, unheld, columns] = m.slice(1).map(Number);
    rows.push({ at: Date.parse(l.iso), standing, stalks, ripe, tiles, piers, unheld, columns });
  }
  return rows;
}

// keeperMansion(lines) → [{ at, text }]: the integrity keeper's mansion lines (foreman/mansion_keeper), the plan kept and
// each change in its cube count.
const KEEPER_MANSION_RE = /integrity keeper: (mansion: .*)$/;
function keeperMansion(lines) {
  const rows = [];
  for (const l of lines) {
    const m = KEEPER_MANSION_RE.exec(l.raw || '');
    if (m && l.iso) rows.push({ at: Date.parse(l.iso), text: m[1] });
  }
  return rows;
}

// keeperTreeFarm(lines) → [{ at, treed, open, blocked, unknown, cells, saturation, target, full }]: the integrity keeper's
// tree farm readings (integrity_keeper_worker, the home band's map), one per change it said; sited false before the home is.
const KEEPER_TREE_RE = /integrity keeper: tree farm: (?:home band (\d+) treed, (\d+) open, (\d+) blocked, (\d+) unknown of (\d+); saturation (none|\d+%) of (\d+)%(, FULL)?|(not sited))/;
function keeperTreeFarm(lines) {
  const rows = [];
  for (const l of lines) {
    const m = KEEPER_TREE_RE.exec(l.raw || '');
    if (!m || !l.iso) continue;
    if (m[9]) { rows.push({ at: Date.parse(l.iso), sited: false }); continue; }
    const [treed, open, blocked, unknown, cells] = m.slice(1, 6).map(Number);
    rows.push({ at: Date.parse(l.iso), sited: true, treed, open, blocked, unknown, cells, saturation: m[6] === 'none' ? null : parseInt(m[6], 10), target: +m[7], full: !!m[8] });
  }
  return rows;
}

function readForemanTrace(dir) {
  return readForemanView(dir || TRACE_DIR);
}

// ── RENDERING ────────────────────────────────────────────────────────────────────────────────────
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

function runForeman(opts = {}) {
  const lines = readForemanTrace(opts.dir);
  // The header NAMES ITS SOURCE, asked of the one module that answers it — never spelled here (Law 16).
  const source = path.relative(recordHomes.BOT_DIR, recordHomes.traceFile('foreman')).replace(/\\/g, '/');
  out.kv('lens', 'foreman');
  out.kv('record', source);

  if (!lines.length) {
    // ABSENCE IS NAMED AS A COUNT, NOT AS A QUIET RUN: the foreman writes its first line at startup, so
    // `lines 0` is a foreman that never came up (Law 25).
    out.zero('lines');
    return { announced: [], refused: [] };
  }
  out.kv('lines', lines.length);

  const announced = announcements(lines);
  const refused = refusals(lines);
  out.kv('announced', announced.length);
  out.kv('refused', refused.length);

  if (announced.length) {
    out.section('announced');
    out.table(['at', 'kind', 'structure', 'layer', 'of', 'text'],
      announced.map(a => [clock(a.at), a.kind, a.structure, a.layer, a.of, a.text]));
  }
  // A refusal's detail is the record's own words; it is printed behind --all, the code always.
  if (refused.length) {
    out.section('refused');
    out.table(opts.verbose ? ['at', 'code', 'detail'] : ['at', 'code'],
      refused.map(r => (opts.verbose ? [clock(r.at), r.code, r.detail] : [clock(r.at), r.code])));
  }
  // The keeper's fields readings: the last 12, every one behind --all.
  const fields = keeperFields(lines);
  out.kv('keeper_fields_readings', fields.length);
  if (fields.length) {
    out.section('keeper_fields');
    out.table(['at', 'room', 'held', 'growing', 'mature', 'untilled', 'unsown', 'blocked', 'stranded'],
      (opts.verbose ? fields : fields.slice(-12)).map(f => [clock(f.at), f.room, f.held, f.growing, f.mature, f.untilled, f.unsown, f.blocked, f.stranded]));
  }
  const mansion = keeperMansion(lines);
  out.kv('keeper_mansion_readings', mansion.length);
  if (mansion.length) {
    out.section('keeper_mansion');
    out.table(['at', 'text'], (opts.verbose ? mansion : mansion.slice(-12)).map(r => [clock(r.at), r.text]));
  }
  const trees = keeperTreeFarm(lines);
  out.kv('keeper_tree_farm_readings', trees.length);
  if (trees.length) {
    out.section('keeper_tree_farm');
    out.table(['at', 'sited', 'treed', 'open', 'blocked', 'unknown', 'cells', 'saturation_pct', 'target_pct', 'full'],
      (opts.verbose ? trees : trees.slice(-12)).map(r => [clock(r.at), r.sited, r.treed ?? null, r.open ?? null, r.blocked ?? null, r.unknown ?? null, r.cells ?? null, r.saturation ?? null, r.target ?? null, r.full ?? null]));
  }
  const plans = keeperPlans(lines);
  out.kv('keeper_plans_readings', plans.length);
  if (plans.length) {
    out.section('keeper_plans');
    out.table(['at', 'base_torches', 'mine_torches', 'structures', 'columns'],
      (opts.verbose ? plans : plans.slice(-6)).map(r => [clock(r.at), r.base_torches, r.mine_torches, r.structures, r.columns]));
  }
  const nursery = keeperNursery(lines);
  out.kv('keeper_nursery_readings', nursery.length);
  if (nursery.length) {
    out.section('keeper_nursery');
    out.table(['at', 'standing', 'stalks', 'ripe', 'tiles', 'piers', 'unheld', 'columns'],
      (opts.verbose ? nursery : nursery.slice(-12)).map(r => [clock(r.at), r.standing, r.stalks, r.ripe, r.tiles, r.piers, r.unheld, r.columns]));
  }
  return { announced, refused, fields, mansion, plans, nursery };
}

module.exports = { runForeman, recordEvents, announcements, refusals, keeperFields, keeperMansion, keeperNursery, keeperPlans, readForemanTrace };
