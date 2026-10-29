#!/usr/bin/env node
/**
 * paper_exec_dev — Unit 23 tests (PS-01 … PS-08).
 *
 * Fully offline + deterministic. No broker, no network, no file writes.
 * All file-system access is covered by the injected fileProbe.
 * All worker-pass execution is covered by injected workerPass stubs.
 *
 * node scripts/execution/tests/paper_exec_dev_step23_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { runPaperExecDevOnce, execDevExitCode } from '../live_broker/paper_exec_dev.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const VALID_ENV  = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };
const VALID_JSON = JSON.stringify({ run_id: 'run_unit23_smoke', long_candidates: [], short_candidates: [] });
const VALID_PROBE = (_path) => VALID_JSON;

// ─── PS-01: dry-run + no keys + injected scanJson → exit_code=0, ran=false ───
{
  const r = await runPaperExecDevOnce({
    argv:     ['--dry-run'],
    env:      {},
    scanJson: VALID_JSON,
  });
  check('PS-01',
    r.exit_code === 0 && r.ok === true && r.dry_run === true
    && r.result?.ran === false && r.result?.reason === 'dry_run',
    'dry-run + no keys → exit_code=0, ran=false, reason=dry_run');
}

// ─── PS-02: dry-run + valid keys + injected scanJson → exit_code=0 same result ─
{
  const r = await runPaperExecDevOnce({
    argv:     ['--dry-run'],
    env:      VALID_ENV,
    scanJson: VALID_JSON,
  });
  check('PS-02',
    r.exit_code === 0 && r.ok === true && r.dry_run === true && r.result?.ran === false,
    'dry-run + valid keys → still exit_code=0, ran=false (dry-run bypasses workerPass)');
}

// ─── PS-03: no keys, no dry-run, injected scanJson → exit_code=2, config_invalid
{
  const r = await runPaperExecDevOnce({
    argv:     [],
    env:      {},
    scanJson: VALID_JSON,
  });
  check('PS-03',
    r.exit_code === 2 && r.ok === false && r.reason === 'config_invalid',
    'no keys + no dry-run → exit_code=2, reason=config_invalid');
}

// ─── PS-04: --scan-log (injected fileProbe) + dry-run → run_id from file ──────
{
  const r = await runPaperExecDevOnce({
    argv:      ['--scan-log', '/fake/path.json', '--dry-run'],
    env:       {},
    fileProbe: VALID_PROBE,
  });
  check('PS-04',
    r.exit_code === 0 && r.ok === true && r.dry_run === true
    && r.result?.run_id === 'run_unit23_smoke',
    '--scan-log via fileProbe + dry-run → exit_code=0, run_id forwarded from file');
}

// ─── PS-05: --scan-log → fileProbe returns invalid JSON → exit_code=2 ────────
{
  const badProbe = (_path) => '{not valid json///';
  const r = await runPaperExecDevOnce({
    argv:      ['--scan-log', '/fake/path.json'],
    env:       VALID_ENV,
    fileProbe: badProbe,
  });
  check('PS-05',
    r.exit_code === 2 && r.ok === false && r.reason === 'scan_log_invalid_json',
    '--scan-log invalid JSON → exit_code=2, reason=scan_log_invalid_json');
}

// ─── PS-06: injected workerPass stub ok + valid keys → exit_code=0, ran=true ─
{
  const stub = async (_ctx) => ({
    ran: true, reason: null, gate: { safe: true },
    steps: { dispatch: { skipped: true }, cycle: { ran: true }, sync: { ran: true } },
    error: null,
  });
  const r = await runPaperExecDevOnce({
    argv:       [],
    env:        VALID_ENV,
    scanJson:   VALID_JSON,
    workerPass: stub,
  });
  check('PS-06',
    r.exit_code === 0 && r.ok === true && r.result?.ran === true
    && r.result?.run_id === 'run_unit23_smoke',
    'stub ok + valid keys → exit_code=0, ran=true, run_id forwarded');
}

// ─── PS-07: injected workerPass throws + valid keys → exit_code=1 ─────────────
{
  const stub = async () => { throw new Error('worker_crashed_unit23'); };
  const r = await runPaperExecDevOnce({
    argv:       [],
    env:        VALID_ENV,
    scanJson:   VALID_JSON,
    workerPass: stub,
  });
  check('PS-07',
    r.exit_code === 1 && r.ok === false && r.reason === 'exec_layer_failed'
    && r.detail?.includes('worker_crashed_unit23'),
    'stub throws → exit_code=1, reason=exec_layer_failed, detail propagated');
}

// ─── PS-08: execDevExitCode — deterministic derivation from result ─────────────
{
  const c0  = execDevExitCode({ exit_code: 0 });
  const c2  = execDevExitCode({ exit_code: 2 });
  const c1n = execDevExitCode({ exit_code: 1 });
  const cnull = execDevExitCode(null);
  const cundef = execDevExitCode(undefined);
  const cmiss  = execDevExitCode({});
  check('PS-08',
    c0 === 0 && c2 === 2 && c1n === 1
    && cnull === 1 && cundef === 1 && cmiss === 1,
    'execDevExitCode: 0→0, 2→2, 1→1, null/undefined/missing→1 (fallback)');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_exec_dev_step23_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
