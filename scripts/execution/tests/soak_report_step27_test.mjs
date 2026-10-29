#!/usr/bin/env node
/**
 * soak_report — Unit 27 tests (SR-01 … SR-06).
 *
 * Fully offline + deterministic. All calls use injectable _listAll +
 * _getEventsLogPath so no real store or live_order_events.jsonl is touched.
 *
 * node scripts/execution/tests/soak_report_step27_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';
import { buildSoakReport } from '../live_broker/soak_report.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const ROOT = join(tmpdir(), `soak_report_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

function makeEventsLog(dir, lines) {
  const p = join(dir, 'events.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

// ─── SR-01: empty store + no events → empty report, no open questions ─────────
{
  const dir = join(ROOT, 'sr01');
  mkdirSync(dir, { recursive: true });
  const evLog = join(dir, 'empty.jsonl');   // does not exist

  let report = null;
  let threw  = false;
  try {
    report = buildSoakReport('dispatch_v1', {
      _listAll:          () => [],
      _getEventsLogPath: () => evLog,
    });
  } catch { threw = true; }

  check('SR-01',
    !threw
    && report?.records_matched === 0
    && report?.events_matched  === 0
    && report?.orders.length   === 0
    && report?.open_questions.length === 0
    && report?.cid_prefix === 'dispatch_v1',
    'empty store + no events log → empty report with zero questions');
}

// ─── SR-02: prefix filtering — matching records included, others excluded ──────
{
  const allRecords = [
    { client_order_id: 'dispatch_v1_run1_AAPL_long_buy', state: 'submitted', schema_version: 1 },
    { client_order_id: 'protect_v1_AAPL_long',           state: 'submitted', schema_version: 1 },
    { client_order_id: 'smoke_abc',                       state: 'filled',    schema_version: 1 },
  ];
  const dir = join(ROOT, 'sr02');
  mkdirSync(dir, { recursive: true });
  const evLog = join(dir, 'empty.jsonl');   // does not exist

  let report;
  try {
    report = buildSoakReport('dispatch_v1', {
      _listAll:          () => allRecords,
      _getEventsLogPath: () => evLog,
    });
  } catch (e) { process.stderr.write('  ERR SR-02: ' + e.message + '\n'); }

  check('SR-02',
    report?.records_matched === 1
    && report?.orders[0]?.client_order_id === 'dispatch_v1_run1_AAPL_long_buy',
    'prefix filtering: only dispatch_v1 records returned; protect_v1 + smoke_ excluded');
}

// ─── SR-03: events read + sorted by ts; events-only CIDs surfaced ─────────────
{
  const dir = join(ROOT, 'sr03');
  mkdirSync(dir, { recursive: true });
  const evLog = makeEventsLog(dir, [
    { type: 'broker_poll_no_change', client_order_id: 'dispatch_v1_run2_TSLA_long_buy', ts: '2026-07-22T10:02:00Z', broker_status: 'new' },
    { type: 'order_submitted',       client_order_id: 'dispatch_v1_run2_TSLA_long_buy', ts: '2026-07-22T10:01:00Z', broker_order_id: 'bo_123' },
    { type: 'broker_poll_no_change', client_order_id: 'OTHER_symbol',                   ts: '2026-07-22T10:03:00Z' }, // excluded
  ]);

  let report;
  try {
    report = buildSoakReport('dispatch_v1', {
      _listAll:          () => [],   // no matching records — events only
      _getEventsLogPath: () => evLog,
    });
  } catch (e) { process.stderr.write('  ERR SR-03: ' + e.message + '\n'); }

  const order = report?.orders?.[0];
  const ev0   = order?.events?.[0];
  const ev1   = order?.events?.[1];

  check('SR-03',
    report?.records_matched === 0
    && report?.events_matched === 2
    && order?.client_order_id === 'dispatch_v1_run2_TSLA_long_buy'
    && order?.state === null            // no record → state null
    && ev0?.type === 'order_submitted'  // sorted earlier ts first
    && ev1?.type === 'broker_poll_no_change'
    && ev0?.client_order_id === undefined, // stripped from grouped view
    'events read + sorted by ts; events-only CIDs surfaced; client_order_id stripped from events');
}

// ─── SR-04: open_questions — filled_not_yet_booked + reconcile_flag_set ────────
{
  const allRecords = [
    {
      client_order_id: 'dispatch_v1_run3_AAPL_long_buy',
      state: 'filled', filled_qty: 10, avg_fill_price: 180.5, schema_version: 1,
    },
    {
      client_order_id: 'dispatch_v1_run3_NVDA_short_sell_short',
      state: 'submitted', reconcile_flag: 'broker_not_found', schema_version: 1,
    },
  ];
  const dir = join(ROOT, 'sr04');
  mkdirSync(dir, { recursive: true });
  const evLog = join(dir, 'empty.jsonl');

  let report;
  try {
    report = buildSoakReport('dispatch_v1', {
      _listAll:          () => allRecords,
      _getEventsLogPath: () => evLog,
    });
  } catch (e) { process.stderr.write('  ERR SR-04: ' + e.message + '\n'); }

  const qs   = report?.open_questions ?? [];
  const qFill = qs.find(q => q.question === 'filled_not_yet_booked');
  const qFlag = qs.find(q => q.question === 'reconcile_flag_set');

  check('SR-04',
    qFill?.cid === 'dispatch_v1_run3_AAPL_long_buy'
    && qFill?.filled_qty === 10
    && qFlag?.cid === 'dispatch_v1_run3_NVDA_short_sell_short'
    && qFlag?.flag === 'broker_not_found',
    'open_questions: filled_not_yet_booked + reconcile_flag_set correctly derived');
}

// ─── SR-05: events_without_record question when record was cleaned up ──────────
{
  const dir = join(ROOT, 'sr05');
  mkdirSync(dir, { recursive: true });
  const evLog = makeEventsLog(dir, [
    { type: 'order_submitted', client_order_id: 'dispatch_v1_run4_AAPL_long_buy', ts: '2026-07-22T09:00:00Z' },
  ]);

  let report;
  try {
    report = buildSoakReport('dispatch_v1', {
      _listAll:          () => [],   // record was removed (cleanup)
      _getEventsLogPath: () => evLog,
    });
  } catch (e) { process.stderr.write('  ERR SR-05: ' + e.message + '\n'); }

  const q = report?.open_questions?.[0];
  check('SR-05',
    q?.question === 'events_without_record'
    && q?.cid === 'dispatch_v1_run4_AAPL_long_buy',
    'events_without_record question when record removed but events remain');
}

// ─── SR-06: invalid / missing cid_prefix → throws with clear message ──────────
{
  let threw06a = false;
  let threw06b = false;
  let msg06a   = '';
  let msg06b   = '';
  try {
    buildSoakReport('', { _listAll: () => [], _getEventsLogPath: () => '/nonexistent' });
  } catch (e) { threw06a = true; msg06a = e.message; }
  try {
    buildSoakReport('bad prefix!', { _listAll: () => [], _getEventsLogPath: () => '/nonexistent' });
  } catch (e) { threw06b = true; msg06b = e.message; }

  check('SR-06',
    threw06a && msg06a.includes('cid-prefix')
    && threw06b && msg06b.includes('cid-prefix'),
    'missing or invalid cid_prefix throws with clear message; no store reads attempted');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nsoak_report_step27_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
