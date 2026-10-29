#!/usr/bin/env node
/**
 * protective_exit_pass_dev — Phase 1 / Unit 20 DEV/SMOKE CLI tests (PEPD-01 … PEPD-08).
 *
 * Fully offline + deterministic. The pass (runProtectiveExitPassOnce) is INJECTED
 * (opts._runProtectiveExitPassOnce) so the CLI's config/positions handling and fail-closed
 * guards are verified WITHOUT touching portfolio_state / order store / a real broker.
 *
 * node scripts/execution/tests/protective_exit_pass_dev_step20_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { runProtectiveExitPassDevOnce, protectiveExitPassDevExitCode } from '../live_broker/protective_exit_pass_dev.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const ROOT = join(tmpdir(), `pepdev_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
mkdirSync(ROOT, { recursive: true });
const CREDS = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };

// Spy pass: records the ctx it received; returns a canned summary (or throws).
function spyPass({ throwErr = null } = {}) {
  const calls = [];
  const fn = async (ctx) => { calls.push(ctx); if (throwErr) throw throwErr; return { positions_in: (ctx.positions?.length ?? 0), planned: 0, already_protected: 0, plan_skipped: 0, dispatch: { submitted: 0 } }; };
  return { fn, calls };
}
function spyMakeBroker() { const calls = { n: 0 }; const sentinel = { __sentinel: true }; return { make: () => { calls.n += 1; return sentinel; }, calls, sentinel }; }

// ─── PEPD-01: happy → pass called once with made broker; exit 0 ──────────────────
{
  const sp = spyPass(); const mb = spyMakeBroker();
  const s = await runProtectiveExitPassDevOnce({ argv: ['--broker-exec', 'alpaca_paper'], env: CREDS, makeBroker: mb.make, _runProtectiveExitPassOnce: sp.fn });
  check('PEPD-01',
    s.ok === true && s.exit_code === 0 && sp.calls.length === 1 && sp.calls[0].broker === mb.sentinel &&
    sp.calls[0].execConfig.paper === true && s.positions_source === 'portfolio_state' && mb.calls.n === 1,
    'happy: exit 0, pass 1× mit made broker + paper execConfig; positions_source=portfolio_state');
}

// ─── PEPD-02: kein --broker-exec → exit 2, pass NICHT aufgerufen ─────────────────
{
  const sp = spyPass();
  const s = await runProtectiveExitPassDevOnce({ argv: [], env: CREDS, _runProtectiveExitPassOnce: sp.fn });
  check('PEPD-02', s.ok === false && s.exit_code === 2 && s.error.reason === 'broker_exec_not_enabled' && sp.calls.length === 0,
    'kein --broker-exec → exit 2 broker_exec_not_enabled, kein Pass-Aufruf');
}

// ─── PEPD-03: non-paper (ALPACA_PAPER=false) → exit 2 config_invalid ─────────────
{
  const sp = spyPass();
  const s = await runProtectiveExitPassDevOnce({ argv: ['--broker-exec', 'alpaca_paper'], env: { ...CREDS, ALPACA_PAPER: 'false' }, _runProtectiveExitPassOnce: sp.fn });
  check('PEPD-03', s.ok === false && s.exit_code === 2 && s.error.reason === 'config_invalid' && sp.calls.length === 0,
    'ALPACA_PAPER=false → exit 2 config_invalid (paper-only), kein Pass-Aufruf');
}

// ─── PEPD-04: --positions-file unlesbar → exit 2 positions_load_failed ───────────
{
  const sp = spyPass();
  const s = await runProtectiveExitPassDevOnce({ argv: ['--broker-exec', 'alpaca_paper', '--positions-file', '/no/such/pos_zzz.json'], env: CREDS, _runProtectiveExitPassOnce: sp.fn });
  check('PEPD-04', s.ok === false && s.exit_code === 2 && s.error.reason === 'positions_load_failed' && sp.calls.length === 0,
    'unlesbare --positions-file → exit 2 positions_load_failed, kein Pass-Aufruf');
}

// ─── PEPD-05: --positions-file kein Array → exit 2 positions_invalid ─────────────
{
  const sp = spyPass();
  const fp = join(ROOT, 'notarray.json'); writeFileSync(fp, JSON.stringify({ not: 'array' }), 'utf8');
  const s = await runProtectiveExitPassDevOnce({ argv: ['--broker-exec', 'alpaca_paper', '--positions-file', fp], env: CREDS, _runProtectiveExitPassOnce: sp.fn });
  check('PEPD-05', s.ok === false && s.exit_code === 2 && s.error.reason === 'positions_invalid' && sp.calls.length === 0,
    'positions-file kein Array → exit 2 positions_invalid, kein Pass-Aufruf');
}

// ─── PEPD-06: --dry-run → exit 0, kein Pass, kein Broker gebaut ──────────────────
{
  const sp = spyPass(); const mb = spyMakeBroker();
  const s = await runProtectiveExitPassDevOnce({ argv: ['--broker-exec', 'alpaca_paper', '--dry-run'], env: CREDS, makeBroker: mb.make, _runProtectiveExitPassOnce: sp.fn });
  check('PEPD-06', s.ok === true && s.dry_run === true && s.exit_code === 0 && sp.calls.length === 0 && mb.calls.n === 0,
    'dry-run → exit 0, kein Pass-Aufruf, kein Broker gebaut');
}

// ─── PEPD-07: Pass wirft → exit 1 unexpected ────────────────────────────────────
{
  const sp = spyPass({ throwErr: new Error('boom') });
  const s = await runProtectiveExitPassDevOnce({ argv: ['--broker-exec', 'alpaca_paper'], env: CREDS, broker: { __b: true }, _runProtectiveExitPassOnce: sp.fn });
  check('PEPD-07', s.ok === false && s.exit_code === 1 && s.error.reason === 'unexpected' && protectiveExitPassDevExitCode(s) === 1 && sp.calls.length === 1,
    'Pass-Throw → exit 1 unexpected (protectiveExitPassDevExitCode=1)');
}

// ─── PEPD-08: --positions-file (Array) → an Pass als ctx.positions weitergereicht ─
{
  const sp = spyPass();
  const fp = join(ROOT, 'positions.json');
  writeFileSync(fp, JSON.stringify([{ symbol: 'AMAT', side: 'long', quantity: 2, entry_price_usd: 100, stop_loss_pct: 8 }]), 'utf8');
  const s = await runProtectiveExitPassDevOnce({ argv: ['--broker-exec', 'alpaca_paper', '--positions-file', fp], env: CREDS, broker: { __b: true }, _runProtectiveExitPassOnce: sp.fn });
  check('PEPD-08',
    s.ok === true && s.exit_code === 0 && s.positions_source === 'file' &&
    sp.calls.length === 1 && Array.isArray(sp.calls[0].positions) && sp.calls[0].positions[0].symbol === 'AMAT',
    'positions-file (Array) → an Pass als ctx.positions übergeben (positions_source=file)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nprotective_exit_pass_dev_step20_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
