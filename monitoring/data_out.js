// Auren_Bot/monitoring/data_out.js
// THE ONE PLACE IN THIS FOLDER THAT WRITES TO STDOUT. Every lens hands it FIELD NAMES and VALUES; it
// owns every space, every separator and every column width in the output. Nothing else here may.
//
// STRUCTURAL, NOT A VOCABULARY GUARD: a lens that cannot form a SENTENCE cannot state a CONCLUSION. Only
// field names, values, and timestamps are admitted here — a whitelist of what may leave this file
// (Law 29), so interpretation has no grammar left to live in.
//
// THE BOT MAY INTERPRET ITSELF. A bot's own recorded sentence about its own reasoning, reproduced
// verbatim, is a copied value, not a claim this file forms — the sentence belongs to the bot and this
// file is the envelope. What a lens may never do is compose a sentence of its own ABOUT a value. Every
// string a lens prints is either a field name it declared or a value it copied, never a third kind.
//
// Output is a table of fields and values; the reader does the interpreting.

'use strict';

const { ABSENT, padRight, padLeft } = require('./report_formatting');

// A field name is an IDENTIFIER, never a phrase, enforced at the call: lower-case, digits, `_` and `.`
// only (`rows_laid` fine, `rows_laid_which_is_too_few` refused as a smuggled sentence).
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
// NEVER TRUNCATES: a column is a convenience and a measurement is the product; when they conflict the
// column gives way (Law 25 — an instrument must not quietly destroy the thing it was asked to report).
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
  // THE CAP IS ON THE PADDING, NEVER ON THE CONTENT: a column pads to at most PAD_CAP, and a cell wider
  // than that simply runs long and leaves the row ragged. Alignment is a convenience, the measurement is
  // the product, and when they collide the convenience gives way (Law 25).
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

// A count of something that did not occur. Reported as a field with 0, never as a phrase about absence.
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
// THE ONE PLACE TRUNCATION IS CORRECT: a ticker line is EPHEMERAL — overwritten a second later and never
// part of an answer — and a line longer than the terminal wraps, which breaks the redraw and leaves torn
// text on screen. Nothing is lost because nothing here was a record.
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

// The same answer as a machine artefact. A caller that asked for JSON wants the structure, not a table.
// This is still data leaving through the one door (Law 16 — the reason check A in preflight can be a
// flat rule with no exceptions).
function json(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

module.exports = { kv, section, table, list, zero, blank, json, ticker, tickerEnd, field, value, KEY_WIDTH };
