#!/usr/bin/env node
/**
 * paper_pass_dev — Phase 1 / Unit 16 DEV/SMOKE CLI tests (PPD-01 … PPD-08).
 *
 * Fully offline + deterministic. The orchestrator (runApprovedDecisionsPass) is INJECTED
 * (opts._runApprovedDecisionsPass) so the CLI's arg/config/runOutput handling and
 * fail-closed guards are verified WITHOUT triggering decision_engine file IO or worker
 * store/lease/portfolio side effects. The broker is injected / spied too.
 *
 * node scripts/execution/tests/paper_pass_dev_step16_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { runPaperPassDevOnce, paperPassDevExitCode } from '../live_broker/paper_pass_dev.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const CREDS = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };   // paper default (ALPACA_PAPER unset → paper)
const RUN_OUTPUT = { run_id: 'run_smoke', long_candidates: [], short_candidates: [], meta: {} };

// Spy orchestrator: records the ctx it received; returns a canned pass summary (or throws).
function spyPass({ throwErr = null } = {}) {
  const calls = [];
  const fn = async (ctx) => { calls.push(ctx); if (throwErr) throw throwErr; return { run_id: ctx.run_id, mode: ctx.mode, decisions_total: 1, approved: 1, emitted: 1, skipped: [], worker: { ran: true } }; };
  return { fn, calls };
}
// Spy makeBroker: counts construction, returns a sentinel broker.
function spyMakeBroker() {
  const calls = { n: 0 };
  const sentinel = { __sentinel: true };
  return { make: (_cfg) => { calls.n += 1; return sentinel; }, calls, sentinel };
}

// ─── PPD-01: happy path → orchestrator called once with paper ctx; makeBroker used ──
{
  const sp = spyPass();
  const mb = spyMakeBroker();
  const s = await runPaperPassDevOnce({
    argv: ['--broker-exec', 'alpaca_paper'], env: CREDS,
    runOutput: RUN_OUTPUT, makeBroker: mb.make, _runApprovedDecisionsPass: sp.fn,
  });
  const ctx = sp.calls[0];
  check('PPD-01',
    s.ok === true && s.exit_code === 0 && s.run_id === 'run_smoke' && s.pass && s.pass.emitted === 1 &&
    sp.calls.length === 1 && ctx.runOutput === RUN_OUTPUT && ctx.broker === mb.sentinel &&
    ctx.execConfig.paper === true && ctx.mode === 'shadow' && mb.calls.n === 1,
    'happy: exit 0, orchestrator 1× mit {runOutput, made broker, paper execConfig, mode shadow}');
}

// ─── PPD-02: config not enabled (no --broker-exec) → exit 2, orchestrator NICHT ──
{
  const sp = spyPass();
  const s = await runPaperPassDevOnce({ argv: [], env: CREDS, runOutput: RUN_OUTPUT, _runApprovedDecisionsPass: sp.fn });
  check('PPD-02',
    s.ok === false && s.exit_code === 2 && s.error.reason === 'broker_exec_not_enabled' && sp.calls.length === 0,
    'kein --broker-exec → exit 2 broker_exec_not_enabled, kein Orchestrator-Aufruf');
}

// ─── PPD-03: non-paper (ALPACA_PAPER=false) → exit 2 config_invalid, kein Aufruf ──
{
  const sp = spyPass();
  const s = await runPaperPassDevOnce({
    argv: ['--broker-exec', 'alpaca_paper'], env: { ...CREDS, ALPACA_PAPER: 'false' },
    runOutput: RUN_OUTPUT, _runApprovedDecisionsPass: sp.fn,
  });
  check('PPD-03',
    s.ok === false && s.exit_code === 2 && s.error.reason === 'config_invalid' && sp.calls.length === 0,
    'ALPACA_PAPER=false → exit 2 config_invalid (paper-only fail-closed), kein Aufruf');
}

// ─── PPD-04: runOutput fehlt (kein --run-log, keine Injection) → exit 2 ──────────
{
  const sp = spyPass();
  const s = await runPaperPassDevOnce({ argv: ['--broker-exec', 'alpaca_paper'], env: CREDS, _runApprovedDecisionsPass: sp.fn });
  check('PPD-04',
    s.ok === false && s.exit_code === 2 && s.error.reason === 'runoutput_missing' && sp.calls.length === 0,
    'fehlender runOutput → exit 2 runoutput_missing, kein Aufruf');
}

// ─── PPD-05: --run-log unlesbar → exit 2 runoutput_load_failed ──────────────────
{
  const sp = spyPass();
  const s = await runPaperPassDevOnce({
    argv: ['--broker-exec', 'alpaca_paper', '--run-log', '/no/such/file_zzz.json'], env: CREDS, _runApprovedDecisionsPass: sp.fn,
  });
  check('PPD-05',
    s.ok === false && s.exit_code === 2 && s.error.reason === 'runoutput_load_failed' && sp.calls.length === 0,
    'unlesbares --run-log → exit 2 runoutput_load_failed, kein Aufruf');
}

// ─── PPD-06: --mode live → exit 2 invalid_args, kein Aufruf ──────────────────────
{
  const sp = spyPass();
  const s = await runPaperPassDevOnce({
    argv: ['--broker-exec', 'alpaca_paper', '--mode', 'live'], env: CREDS, runOutput: RUN_OUTPUT, _runApprovedDecisionsPass: sp.fn,
  });
  check('PPD-06',
    s.ok === false && s.exit_code === 2 && s.error.reason === 'invalid_args' && sp.calls.length === 0,
    '--mode live → exit 2 invalid_args (fail-closed), kein Aufruf');
}

// ─── PPD-07: --dry-run → exit 0, kein Orchestrator, kein Broker gebaut ──────────
{
  const sp = spyPass();
  const mb = spyMakeBroker();
  const s = await runPaperPassDevOnce({
    argv: ['--broker-exec', 'alpaca_paper', '--dry-run'], env: CREDS,
    runOutput: RUN_OUTPUT, makeBroker: mb.make, _runApprovedDecisionsPass: sp.fn,
  });
  check('PPD-07',
    s.ok === true && s.dry_run === true && s.exit_code === 0 && s.run_id === 'run_smoke' &&
    sp.calls.length === 0 && mb.calls.n === 0,
    'dry-run → exit 0, kein Orchestrator-Aufruf, kein Broker gebaut');
}

// ─── PPD-08: Orchestrator wirft → exit 1 unexpected ──────────────────────────────
{
  const sp = spyPass({ throwErr: new Error('boom') });
  const s = await runPaperPassDevOnce({
    argv: ['--broker-exec', 'alpaca_paper'], env: CREDS, runOutput: RUN_OUTPUT,
    broker: { __b: true }, _runApprovedDecisionsPass: sp.fn,
  });
  check('PPD-08',
    s.ok === false && s.exit_code === 1 && s.error.reason === 'unexpected' &&
    paperPassDevExitCode(s) === 1 && sp.calls.length === 1,
    'Orchestrator-Throw → exit 1 unexpected (paperPassDevExitCode=1)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_pass_dev_step16_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
