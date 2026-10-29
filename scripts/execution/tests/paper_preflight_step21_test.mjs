#!/usr/bin/env node
/**
 * paper_preflight — Phase 1 / Unit 21 READ-ONLY pre-flight report tests (PF-01 … PF-08).
 *
 * Fully offline + deterministic. argv/env are passed in; the file probe is INJECTED so no
 * real files are touched. The report executes nothing (no broker, no pass, no store) — the
 * tests assert classification + read-only behaviour only.
 *
 * node scripts/execution/tests/paper_preflight_step21_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { buildPaperPreflightReport, preflightExitCode, PREFLIGHT_STATUS } from '../live_broker/paper_preflight.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const CREDS = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };
// File probe stub: map of path → probe result.
function probeFrom(map) { return (path) => map[path] ?? { exists: false }; }

// ─── PF-01: off (kein --broker-exec) → not_ready, exit 0, kein misconfig ────────
{
  const r = buildPaperPreflightReport({ argv: [], env: {} });
  check('PF-01',
    r.broker_exec.status === PREFLIGHT_STATUS.NOT_READY && r.broker_exec.reasons.includes('broker_exec_off') &&
    r.summary.overall_status === PREFLIGHT_STATUS.NOT_READY && preflightExitCode(r) === 0,
    'kein --broker-exec → broker_exec_off, overall not_ready, exit 0 (kein Fehler)');
}

// ─── PF-02: alpaca_paper aber Keys fehlen → not_ready (credentials_missing) ──────
{
  const r = buildPaperPreflightReport({ argv: ['--broker-exec', 'alpaca_paper'], env: {} });
  check('PF-02',
    r.broker_exec.status === PREFLIGHT_STATUS.NOT_READY && r.broker_exec.reasons.includes('credentials_missing') &&
    r.broker_exec.credentials_present === false && r.summary.missing_for_soak.includes('alpaca_paper_keys') &&
    preflightExitCode(r) === 0,
    'fehlende Keys → not_ready credentials_missing, missing_for_soak=[alpaca_paper_keys], exit 0');
}

// ─── PF-03: ALPACA_PAPER=false → misconfigured, exit 2 ──────────────────────────
{
  const r = buildPaperPreflightReport({ argv: ['--broker-exec', 'alpaca_paper'], env: { ...CREDS, ALPACA_PAPER: 'false' } });
  check('PF-03',
    r.broker_exec.status === PREFLIGHT_STATUS.MISCONFIGURED && r.broker_exec.reasons.includes('non_paper_refused') &&
    r.summary.overall_status === PREFLIGHT_STATUS.MISCONFIGURED && preflightExitCode(r) === 2,
    'ALPACA_PAPER=false → misconfigured non_paper_refused, exit 2');
}

// ─── PF-04: invalid mode → misconfigured ────────────────────────────────────────
{
  const r = buildPaperPreflightReport({ argv: ['--broker-exec', 'bogus'], env: CREDS });
  check('PF-04',
    r.broker_exec.status === PREFLIGHT_STATUS.MISCONFIGURED && r.broker_exec.reasons.includes('invalid_broker_exec_mode') &&
    preflightExitCode(r) === 2,
    'ungültiger --broker-exec Modus → misconfigured invalid_broker_exec_mode, exit 2');
}

// ─── PF-05: paper+creds, kein run-log → E2E not_ready(run_log_missing); protective ready ─
{
  const r = buildPaperPreflightReport({ argv: ['--broker-exec', 'alpaca_paper'], env: CREDS });
  check('PF-05',
    r.broker_exec.enabled === true &&
    r.paths.e2e_paper_pass.status === PREFLIGHT_STATUS.NOT_READY &&
    r.paths.e2e_paper_pass.blocking_reasons.includes('run_log_missing') &&
    r.paths.protective_exit_pass.status === PREFLIGHT_STATUS.READY &&
    r.paths.protective_exit_pass.positions_source === 'portfolio_state',
    'paper+creds ohne run-log → E2E not_ready(run_log_missing), protective ready(portfolio_state)');
}

// ─── PF-06: gültiges run-log + gültige positions-file → beide ready ─────────────
{
  const probe = probeFrom({
    '/p/run.json': { exists: true, parsed: { run_id: 'r1', long_candidates: [], short_candidates: [] } },
    '/p/pos.json': { exists: true, parsed: [{ symbol: 'AMAT', side: 'long', quantity: 2, entry_price_usd: 100, stop_loss_pct: 8 }] },
  });
  const r = buildPaperPreflightReport({ argv: ['--broker-exec', 'alpaca_paper', '--run-log', '/p/run.json', '--positions-file', '/p/pos.json'], env: CREDS, fileProbe: probe });
  check('PF-06',
    r.paths.e2e_paper_pass.status === PREFLIGHT_STATUS.READY && r.paths.e2e_paper_pass.run_log.status === 'valid' && r.paths.e2e_paper_pass.dry_run_possible === true &&
    r.paths.protective_exit_pass.status === PREFLIGHT_STATUS.READY && r.paths.protective_exit_pass.positions_file.status === 'valid' &&
    r.summary.overall_status === PREFLIGHT_STATUS.READY &&
    r.summary.missing_for_soak.includes('live_account_connectivity_not_checked'),
    'beide Inputs valide → beide ready, overall ready, Konnektivität als unverifiziert markiert');
}

// ─── PF-07: kaputtes run-log + non-array positions-file → not_ready je Pfad ──────
{
  const probe = probeFrom({
    '/p/bad.json': { exists: true, parse_error: 'Unexpected token' },
    '/p/obj.json': { exists: true, parsed: { not: 'array' } },
  });
  const r = buildPaperPreflightReport({ argv: ['--broker-exec', 'alpaca_paper', '--run-log', '/p/bad.json', '--positions-file', '/p/obj.json'], env: CREDS, fileProbe: probe });
  check('PF-07',
    r.paths.e2e_paper_pass.status === PREFLIGHT_STATUS.NOT_READY && r.paths.e2e_paper_pass.blocking_reasons.includes('run_log_invalid_json') &&
    r.paths.protective_exit_pass.status === PREFLIGHT_STATUS.NOT_READY && r.paths.protective_exit_pass.blocking_reasons.includes('positions_file_invalid') &&
    preflightExitCode(r) === 0,
    'kaputtes run-log → run_log_invalid_json; non-array positions → positions_file_invalid; exit 0');
}

// ─── PF-08: read-only / pure — Report-Struktur + caveats, keine Seiteneffekte ────
{
  let probeCalls = 0;
  const probe = (_p) => { probeCalls += 1; return { exists: false }; };
  const r1 = buildPaperPreflightReport({ argv: ['--broker-exec', 'alpaca_paper', '--run-log', '/x'], env: CREDS, fileProbe: probe });
  const r2 = buildPaperPreflightReport({ argv: ['--broker-exec', 'alpaca_paper', '--run-log', '/x'], env: CREDS, fileProbe: probe });
  check('PF-08',
    r1.summary.caveats.includes('read_only_report') &&
    typeof r1.generated_at === 'string' && r1.broker_exec && r1.paths.e2e_paper_pass && r1.paths.protective_exit_pass &&
    r1.paths.e2e_paper_pass.status === r2.paths.e2e_paper_pass.status && probeCalls >= 2,
    'Report ist read-only/pure: caveats gesetzt, deterministische Klassifikation, nur Probe-Reads');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_preflight_step21_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
