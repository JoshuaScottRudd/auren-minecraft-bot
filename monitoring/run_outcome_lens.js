// The foreman's finished verdict is copied as recorded facts, including every failed check (Law 25).
'use strict';
const fs = require('fs');
const out = require('./data_out');

function readOutcome() {
  const file = require(require('./lens_paths').bot('foreman/utils/run_outcome')).outcomeFile();
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runOutcome() {
  const record = readOutcome();
  out.section('run_outcome');
  out.kv('found', !!record);
  if (!record) return null;
  for (const field of ['outcome', 'stage', 'reason', 'exit_code', 'checks_passed', 'checks_total',
    'woke', 'woke_on', 'ran_min', 'started_at', 'ended_at', 'reported_by']) out.kv(field, record[field]);
  out.table(['failed_check', 'detail'], (record.failed_checks || []).map(row => [row.name, row.detail]));
  return record;
}

module.exports = { readOutcome, runOutcome };
