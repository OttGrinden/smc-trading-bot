#!/usr/bin/env node
/**
 * paper_preflight dispatch — Unit 25 tests (DP-01 … DP-07).
 *
 * Verifies that dispatch_pass is assessed separately from maintenance paths
 * and that overall_status is not affected by dispatch readiness.
 *
 * Fully offline + deterministic. No broker, no network, no file writes.
 *
 * node scripts/execution/tests/paper_preflight_dispatch_step25_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { buildPaperPreflightReport, PREFLIGHT_STATUS } from '../live_broker/paper_preflight.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const VALID_CREDS  = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };
const VALID_ARGV   = ['--broker-exec', 'alpaca_paper'];
const VALID_SCAN   = { run_id: 'run_dp_smoke', long_candidates: [], short_candidates: [] };

// Probe factories
const missingProbe    = (_p) => ({ exists: false });
const badJsonProbe    = (_p) => ({ exists: true, parse_error: 'Unexpected token' });
const validScanProbe  = (_p) => ({ exists: true, parsed: VALID_SCAN });
const validRunProbe   = (_p) => ({ exists: true, parsed: { run_id: 'run_maint', long_candidates: [], short_candidates: [] } });
const validArrayProbe = (_p) => ({ exists: true, parsed: [] });

function makeMultiProbe(scanPath, runPath, posPath) {
  return (p) => {
    if (p === scanPath) return validScanProbe(p);
    if (p === runPath)  return validRunProbe(p);
    if (p === posPath)  return validArrayProbe(p);
    return missingProbe(p);
  };
}

// ─── DP-01: Fall A — credentials missing → dispatch not_ready (independent of dispatch_requested) ─
{
  const r = buildPaperPreflightReport({
    argv: VALID_ARGV,
    env:  {},
  });
  const dp = r.paths.dispatch_pass;
  check('DP-01',
    dp !== undefined
    && dp.status === PREFLIGHT_STATUS.NOT_READY
    && dp.blocking_reasons.includes('credentials_missing')
    && dp.dispatch_requested === false
    && dp.getAccount_available === null,
    'credentials missing → dispatch not_ready; getAccount_available=null; dispatch_requested=false');
}

// ─── DP-02: Fall B — config OK, no --scan-log, no --exec-dispatch → dry_run_only ─
{
  const r = buildPaperPreflightReport({
    argv: VALID_ARGV,
    env:  VALID_CREDS,
  });
  const dp = r.paths.dispatch_pass;
  check('DP-02',
    dp.status === PREFLIGHT_STATUS.DRY_RUN_ONLY
    && dp.dispatch_requested === false
    && dp.scan_log.provided === false
    && dp.getAccount_available === 'assumed'
    && dp.dry_run_possible === true,
    'no --scan-log, no --exec-dispatch → dry_run_only; getAccount_available=assumed; dry_run_possible=true');
}

// ─── DP-03: Fall C — config OK, --exec-dispatch, valid --scan-log → ready ────────
{
  const r = buildPaperPreflightReport({
    argv:      [...VALID_ARGV, '--exec-dispatch', '--scan-log', '/p/scan.json'],
    env:       VALID_CREDS,
    fileProbe: validScanProbe,
  });
  const dp = r.paths.dispatch_pass;
  check('DP-03',
    dp.status === PREFLIGHT_STATUS.READY
    && dp.dispatch_requested === true
    && dp.scan_log.status === 'valid'
    && dp.getAccount_available === 'assumed'
    && dp.dry_run_possible === true,
    '--exec-dispatch + valid --scan-log → ready; getAccount_available=assumed; dispatch_requested=true');
}

// ─── DP-04: Fall D — --scan-log provided but file not found → not_ready ──────────
{
  const r = buildPaperPreflightReport({
    argv:      [...VALID_ARGV, '--exec-dispatch', '--scan-log', '/p/missing.json'],
    env:       VALID_CREDS,
    fileProbe: missingProbe,
  });
  const dp = r.paths.dispatch_pass;
  check('DP-04',
    dp.status === PREFLIGHT_STATUS.NOT_READY
    && dp.scan_log.status === 'unreadable'
    && dp.blocking_reasons.includes('scan_log_unreadable')
    && dp.dry_run_possible === false,
    '--scan-log missing file → dispatch not_ready, scan_log_unreadable blocking_reason');
}

// ─── DP-05: Fall D (variant) — --scan-log invalid JSON → not_ready ───────────────
{
  const r = buildPaperPreflightReport({
    argv:      [...VALID_ARGV, '--exec-dispatch', '--scan-log', '/p/bad.json'],
    env:       VALID_CREDS,
    fileProbe: badJsonProbe,
  });
  const dp = r.paths.dispatch_pass;
  check('DP-05',
    dp.status === PREFLIGHT_STATUS.NOT_READY
    && dp.scan_log.status === 'invalid_json'
    && dp.blocking_reasons.includes('scan_log_invalid_json'),
    '--scan-log invalid JSON → dispatch not_ready, scan_log_invalid_json blocking_reason');
}

// ─── DP-06: overall_status NOT affected by dispatch — maintenance paths dominate ─
// Even when dispatch is ready, overall_status only reflects e2e + protective-exit.
{
  const r = buildPaperPreflightReport({
    argv: [
      '--broker-exec', 'alpaca_paper',
      '--exec-dispatch', '--scan-log', '/p/scan.json',
      '--run-log',       '/p/run.json',
      '--positions-file', '/p/pos.json',
    ],
    env:       VALID_CREDS,
    fileProbe: makeMultiProbe('/p/scan.json', '/p/run.json', '/p/pos.json'),
  });
  const dp = r.paths.dispatch_pass;
  check('DP-06',
    r.summary.overall_status === PREFLIGHT_STATUS.READY
    && r.summary.dispatch_status === PREFLIGHT_STATUS.READY
    && dp.status === PREFLIGHT_STATUS.READY
    && r.paths.e2e_paper_pass.status === PREFLIGHT_STATUS.READY
    && r.paths.protective_exit_pass.status === PREFLIGHT_STATUS.READY,
    'all paths ready: overall_status=ready; dispatch_status=ready in summary (informational)');
}

// ─── DP-07: dispatch dry_run_only does NOT degrade overall when maintenance is ready ─
// Dispatch dry_run_only (no --scan-log) must not pull overall below READY.
{
  const r = buildPaperPreflightReport({
    argv: [
      '--broker-exec', 'alpaca_paper',
      '--run-log',       '/p/run.json',
      '--positions-file', '/p/pos.json',
    ],
    env:       VALID_CREDS,
    fileProbe: (p) => {
      if (p === '/p/run.json')  return { exists: true, parsed: { run_id: 'r', long_candidates: [], short_candidates: [] } };
      if (p === '/p/pos.json')  return { exists: true, parsed: [] };
      return { exists: false };
    },
  });
  const dp = r.paths.dispatch_pass;
  check('DP-07',
    r.summary.overall_status === PREFLIGHT_STATUS.READY
    && dp.status === PREFLIGHT_STATUS.DRY_RUN_ONLY
    && r.summary.missing_for_soak.includes('dispatch_broker_account_connectivity_not_checked')
    && r.summary.missing_for_soak.includes('live_account_connectivity_not_checked'),
    'dispatch dry_run_only does NOT degrade overall_status=ready; both account checks in missing_for_soak');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_preflight_dispatch_step25_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
