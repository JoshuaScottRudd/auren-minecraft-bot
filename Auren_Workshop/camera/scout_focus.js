// scout_focus — what the scout seat films, ranked. The scout seat is one directed camera (`Cam_Scout`) that moves
// between bots: when several bots are doing things worth filming at once, it films the one whose activity the
// operator ranked highest. The operator sets the rank before a run on the Cutting Room's scout page, which writes
// `clients/scout_focus.json`; the rig re-reads it at every pick, so a change during a run applies at the next pick.
//
// The activities themselves are the bots' facts (custom_api/activity_log.js): which body began or ended what, and
// where. This file only orders them. The bots never see the rank, so nothing in the mind performs for the camera.
//
// readFocus() → { enable, rank, off, updatedAt, source }. `rank` is always every kind once, the file's order first
// and any kind it does not name after, so a kind added later is filmed last rather than never. `off` kinds are not
// filmed. `enable` is whether the next filmed run raises the seat (record_overlay's `--scout` switch reads it).
// writeFocus(focus) validates and writes; pick(open, focus, current, now, minDwellMs) chooses the span to film.

'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../workshop_paths');
const { KINDS } = require(paths.bot('custom_api/activity_log.js'));

const FILE = path.join(__dirname, 'clients', 'scout_focus.json');
// With no file yet: fights first, then the work that happens in one place and reads on screen.
const DEFAULT_RANK = ['fight', 'squid_hunt', 'pen_crossing', 'herding', 'shepherd', 'shearing', 'culling'];

function complete(rank) {
  const named = (Array.isArray(rank) ? rank : []).filter((k, i, a) => KINDS[k] && a.indexOf(k) === i);
  return [...named, ...DEFAULT_RANK.filter(k => !named.includes(k)), ...Object.keys(KINDS).filter(k => !named.includes(k) && !DEFAULT_RANK.includes(k))];
}

function readFocus() {
  let f = null;
  try { f = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { /* no file, or mid-write: the default answers */ }
  if (!f || typeof f !== 'object') return { enable: false, rank: complete(DEFAULT_RANK), off: [], updatedAt: null, source: 'default' };
  return {
    enable: f.enable === true,
    rank: complete(f.rank),
    off: (Array.isArray(f.off) ? f.off : []).filter(k => KINDS[k]),
    updatedAt: f.updatedAt || null,
    source: 'file',
  };
}

function writeFocus({ enable, rank, off }) {
  if (typeof enable !== 'boolean') throw new Error('scout_focus: enable must be true or false.');
  if (!Array.isArray(rank) || !rank.length || rank.some(k => !KINDS[k])) throw new Error(`scout_focus: rank must list activity kinds (${Object.keys(KINDS).join(', ')}).`);
  if (!Array.isArray(off) || off.some(k => !KINDS[k])) throw new Error('scout_focus: off must list activity kinds.');
  const body = { enable, rank: complete(rank), off: [...new Set(off)], updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, FILE);
  return readFocus();
}

// pick(open, focus, current, now, minDwellMs) → the span to film, or null to stay where it is.
// The best open span is the highest-ranked kind not switched off; between two of one kind, the one that began first,
// so the seat does not hop between equals. The span it is already filming is kept while it stays open, unless a
// higher-ranked kind is open and the seat has filmed this one at least minDwellMs. Nothing open: null.
function pick(open, focus, current, now, minDwellMs) {
  const rankOf = k => focus.rank.indexOf(k);
  const live = open.filter(s => !focus.off.includes(s.kind))
    .sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || a.start - b.start);
  if (!live.length) return null;
  const best = live[0];
  const still = current && live.find(s => s.key === current.key);
  if (!still) return best;
  if (rankOf(best.kind) >= rankOf(still.kind)) return still;
  return now - current.since >= minDwellMs ? best : still;
}

module.exports = { FILE, DEFAULT_RANK, readFocus, writeFocus, pick };
