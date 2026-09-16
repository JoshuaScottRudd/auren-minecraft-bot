// Auren_Bot/monitoring/data_out.js
// THE ONE PLACE IN THIS FOLDER THAT WRITES TO STDOUT. Every lens hands it FIELD NAMES and VALUES; it
// owns every space, every separator and every column width in the output. Nothing else here may.
//
// ── THE ASK (Architect 2026-09-16) ──────────────────────────────────────────────────────────────────
// *"First of all the bot has the right to interpret its own data because it's the one doing the
// reasoning. Just like I can tell you why I made a choice so can the bot. Who cannot is the lens who had
// no participation within the decision making process. The purpose of the lens is to extract data from
// large files without reading it.*
//
// *So back to the guard. How about this. Each lens answers a question without any string… there's no
// longer any sentences or grammar in the output of the monitor. It answers a question directly and
// outputs the data directly… The purpose is that if you prevent trace monitor from saying anything except
// variables and timestamps then it can never interpret data right?"*
//
// ── WHY THIS SHAPE BEATS THE VOCABULARY GUARD IT REPLACES ───────────────────────────────────────────
// The first attempt (2026-09-16, same day) scanned printed strings for interpretive WORDS — "because",
// "likely", "not a fault". That is a BLACKLIST across an open field, and Law 29 says a blacklist permits
// everything it forgot to name. It could be walked around by a synonym, it argued with its own author
// over `may` meaning PERMITTED rather than PERHAPS, and it could never catch an interpretation phrased in
// words nobody thought to list. It was the wrong shape.
//
// THE RIGHT SHAPE IS STRUCTURAL: a lens that cannot form a SENTENCE cannot state a CONCLUSION. Remove
// prose from the instrument entirely and interpretation has nowhere to live — not because the words are
// forbidden, but because there is no grammar left to carry them. That is a whitelist: field names,
// values, timestamps, and nothing else is admitted.
//
// ── WHERE INTERPRETATION IS STILL LEGAL, AND WHY THAT IS NOT A LOOPHOLE ─────────────────────────────
// THE BOT MAY INTERPRET ITSELF. `farm_manager` writing `[STUCK — nothing worked]` into the record is a
// participant reporting its own reasoning, and it is the only thing in the system that was present for
// that decision. A lens reproducing that text VERBATIM is copying a value, not forming a claim — the
// sentence belongs to the bot and the lens is the envelope. What the lens may never do is compose a
// sentence of its own ABOUT the value, because it was not there.
//
// So the rule is not "no strings reach the terminal". It is: EVERY STRING A LENS PRINTS IS EITHER A FIELD
// NAME IT DECLARED OR A VALUE IT COPIED. It never writes a third kind.
//
// ── THE COST, NAMED RATHER THAN DISCOVERED LATER ────────────────────────────────────────────────────
// Output stops reading like a report and starts reading like a table. That is the intended trade: a
// report is persuasive and a table is not, and the reader is meant to do the persuading.

'use strict';

const { ABSENT, padRight, padLeft } = require('./report_formatting');

// A field name is an IDENTIFIER, never a phrase — this is what makes grammar impossible upstream. The
// shape is enforced here at the call rather than trusted, because a field name is the one string a lens
// authors and it is exactly where a sentence would try to re-enter (`rows_laid` fine, `rows laid so far`
// refused, and so is the underscore-smuggled `rows_laid_which_is_too_few`).
const FIELD = /^[a-z0-9][a-z0-9_.]{0,46}[a-z0-9]$|^[a-z0-9]$/;

function field(name) {
  const n = String(name);
  if (!FIELD.test(n)) {
    throw new Error(`data_out: "${n}" is not a field name. A field is lower-case, digits, _ and . only, `
      + 'no spaces and no punctuation — a lens declares fields, it does not write phrases.');
  }
  return n;
}

// Values are printed as they arrive. A string here is a value the lens READ, never one it wrote, so it
// is passed through untouched — including a bot's own sentence about its own reasoning.
function value(v) {
  if (v === null || v === undefined) return ABSENT;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ABSENT;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

// ── The emitters. Everything below owns the spaces; nothing above it does. ──────────────────────────

const KEY_WIDTH = 28;

// One field, one value. The whole vocabulary of a scalar answer.
//
// NEVER TRUNCATES, and that is not a style choice. The first cut of this used `padRight`, which pads AND
// clips to the column — so `farm_standing_at_first_sweep` lost its tail and printed as
// `farm_standing_at_first_sweepfalse`, a field name welded to its own value. A column is a convenience
// and a measurement is the product; when they conflict the column gives way (Law 25 — an instrument must
// not quietly destroy the thing it was asked to report).
function kv(name, v) {
  const n = field(name);
  console.log(n + (n.length >= KEY_WIDTH ? ' ' : ' '.repeat(KEY_WIDTH - n.length)) + value(v));
}

// A named block. The name is the QUESTION the block answers, as a field.
function section(name) {
  console.log('');
  console.log(`[${field(name)}]`);
}

// A table: declared field names, then rows of values. Width is computed from the data, so no caller
// ever passes a pad count and no column carries a hand-tuned literal.
function table(fields, rows) {
  const names = fields.map(field);
  if (!rows.length) {
    console.log(names.join('\t'));
    return;
  }
  // THE CAP IS ON THE PADDING, NEVER ON THE CONTENT — and that distinction is the whole lesson here.
  // The first cut used `padRight`, which pads AND clips: a 60-char cap silently cut the navigator's own
  // owner string mid-measurement. Removing the cap fixed the loss and made one 2,000-character bot line
  // pad every other row out to 2,000 columns. So: a column is padded to at most PAD_CAP, and a cell
  // wider than that simply runs long and leaves the row ragged. Alignment is a convenience, the
  // measurement is the product, and when they collide the convenience gives way (Law 25).
  const PAD_CAP = 40;
  const cells = rows.map(r => r.map(value));
  const w = names.map((n, i) => Math.min(PAD_CAP, Math.max(n.length, ...cells.map(r => (r[i] || '').length))));
  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const line = (r) => r.map((c, i) => (i === r.length - 1 ? c : pad(c, w[i]))).join('  ').trimEnd();
  console.log(line(names));
  for (const r of cells) console.log(line(r));
}

// A single-column table — a list of values under one declared field name.
function list(name, values) {
  table([name], values.map(v => [v]));
}

// A count of something that did not occur. Reported as a field with 0, never as a phrase about absence:
// "no A* path lines in the latest run" was where a reason for the zero used to get attached.
function zero(name) {
  kv(name, 0);
}

function blank() {
  console.log('');
}

// ── THE LIVE TICKER — the one place a line is overwritten instead of appended ───────────────────────
// `--watch` redraws a single status line in place on a TTY. The ESCAPE CODES LIVE HERE, with every other
// piece of presentation, so no lens needs its own `process.stdout.write` and check A in preflight can be
// a flat rule with no exceptions. The caller hands the same `field=value` text it would print anyway.
//
// THIS IS THE ONE PLACE TRUNCATION IS CORRECT, and it is worth saying why given the rule everywhere else
// forbids it: a ticker line is EPHEMERAL — overwritten a second later and never part of an answer — and a
// line longer than the terminal wraps, which breaks the redraw and leaves torn text on screen. Nothing is
// lost because nothing here was a record.
let _tickerOpen = false;
function ticker(text) {
  if (!process.stdout.isTTY) { console.log(text); return; }
  const width = process.stdout.columns || 0;
  const fit = width && text.length >= width ? `${text.slice(0, width - 2)}…` : text;
  process.stdout.write(`\r\x1b[2K${fit}`);
  _tickerOpen = true;
}
function tickerEnd() {
  if (_tickerOpen) { process.stdout.write('\n'); _tickerOpen = false; }
}

// The same answer as a machine artefact. A caller that asked for JSON wants the structure, not a table,
// and this is still data leaving through the one door rather than a second stdout writer growing in a
// lens (Law 16 — the reason check A in preflight can be a flat rule with no exceptions).
function json(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

module.exports = { kv, section, table, list, zero, blank, json, ticker, tickerEnd, field, value, KEY_WIDTH };
