#!/usr/bin/env node
/**
 * E2E PaperPass — Phase 1 / Unit 15 tests (E2E-01 … E2E-08).
 *
 * Verifies the thin end-to-end stitch runApprovedDecisionsPass:
 *   buildDecisions → approvedIntentsFromDecisions (approved, UNSIZED)
 *                  → runWorkerPassOnce(sizeFromAccount:true)  (account-based sizing)
 *
 * Isolated + deterministic + offline (mirrors worker_pass test harness):
 *   - temp OrderStore (_setOrderStorePaths) + temp lease (_setLeasePath)
 *   - temp portfolio state/ledger (_setTestPaths)
 *   - injected fake broker (submitOrder + getOrderByClientId + getAccount)
 *   - buildDecisions is injected (ctx._buildDecisions) → no decision_engine file IO
 *
 * node scripts/execution/tests/e2e_paper_pass_step15_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { initPortfolio, _setTestPaths, _clearTestPaths } from '../portfolio/portfolio_state.mjs';
import { runApprovedDecisionsPass } from '../live_broker/e2e_paper_pass.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `e2epass_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
mkdirSync(ROOT, { recursive: true });

const PAPER_CFG = Object.freeze({ enabled: true, mode: 'alpaca_paper', paper: true, base_url: 'https://paper-api.alpaca.markets', key_id: 'k', secret_key: 's' });

async function withEnv(tag, fn) {
  const d = join(ROOT, tag);
  const ordersDir = join(d, 'orders');
  const pfDir     = join(d, 'portfolio');
  mkdirSync(ordersDir, { recursive: true });
  mkdirSync(pfDir, { recursive: true });
  const leaseP = join(ordersDir, '.paper_runner.lease');
  const statePath = join(pfDir, 'state.json');
  writeFileSync(statePath, JSON.stringify(initPortfolio(), null, 2) + '\n', 'utf8');
  _setOrderStorePaths({ dir: ordersDir, eventsLog: join(ordersDir, 'live_order_events.jsonl') });
  _setLeasePath(leaseP);
  _setTestPaths({ state: statePath, history: join(pfDir, 'hist.jsonl'), ledger: join(pfDir, 'ledger.jsonl') });
  try { return await fn(); }
  finally { _clearOrderStorePaths(); _clearLeasePath(); _clearTestPaths(); }
}

// Fake broker. accountOrThrow controls getAccount; noAccount omits the method entirely.
function fakeBroker({ accountOrThrow, noAccount = false } = {}) {
  const calls = { submitOrder: 0, getOrderByClientId: 0, getAccount: 0 };
  const b = {
    calls,
    async submitOrder(r) { calls.submitOrder += 1; return { provider: 'alpaca', client_order_id: r.client_order_id, broker_order_id: 'B_' + r.client_order_id, broker_status: 'accepted' }; },
    async getOrderByClientId(cid) { calls.getOrderByClientId += 1; return { provider: 'alpaca', broker_order_id: 'B_' + cid, broker_status: 'accepted', filled_qty: 0, avg_fill_price: null }; },
  };
  if (!noAccount) b.getAccount = async () => { calls.getAccount += 1; if (typeof accountOrThrow === 'function') return accountOrThrow(); return accountOrThrow; };
  return b;
}
const okAccount = (over = {}) => ({ provider: 'alpaca', account_id: 'a1', currency: 'USD', status: 'ACTIVE', cash: 10000, buying_power: 10000, portfolio_value: 10000, equity: 10000, paper: true, ts: '2026-06-19T10:00:00.000Z', ...over });

// decision_engine { intent, decision } shape (intent is UNSIZED: price_usd, no quantity).
function dec({ symbol = 'AMAT', side = 'long', price_usd = 100, approved = true, run_id = 'run_e2e', i = '1' } = {}) {
  return { intent: { symbol, side, asset_type: 'stock', price_usd, intent_id: 'int_' + i }, decision: { decision_id: 'dec_' + i, symbol, side, execution_ready: approved, run_id } };
}
const runOutput = { run_id: 'run_e2e', long_candidates: [], short_candidates: [], meta: {} };

// ─── E2E-01: happy path — approved unsized → sized → dispatched ───────────────
await withEnv('e2e01', async () => {
  const b = fakeBroker({ accountOrThrow: okAccount() });
  const fakeBuild = () => [dec({ symbol: 'AMAT', approved: true, i: '1' }), dec({ symbol: 'MU', approved: false, i: '2' })];
  const s = await runApprovedDecisionsPass({ runOutput, broker: b, execConfig: PAPER_CFG, _buildDecisions: fakeBuild, run_id: 'run_e2e' });
  check('E2E-01',
    s.decisions_total === 2 && s.approved === 1 && s.emitted === 1 &&
    s.worker.ran === true && s.worker.steps.sizing.totals.sized === 1 && s.worker.steps.dispatch.submitted === 1 &&
    b.calls.getAccount === 1 && b.calls.submitOrder === 1,
    'build→approved(1)→unsized→sized(1)→dispatched(1); getAccount+submit je 1×');
});

// ─── E2E-02: approved-only forwarded (blocked never dispatched) ───────────────
await withEnv('e2e02', async () => {
  const b = fakeBroker({ accountOrThrow: okAccount() });
  const fakeBuild = () => [dec({ symbol: 'AMAT', approved: true, i: '1' }), dec({ symbol: 'GD', side: 'short', approved: true, i: '2' }), dec({ symbol: 'MU', approved: false, i: '3' })];
  const s = await runApprovedDecisionsPass({ runOutput, broker: b, execConfig: PAPER_CFG, _buildDecisions: fakeBuild, run_id: 'run_e2e' });
  check('E2E-02',
    s.decisions_total === 3 && s.approved === 2 && s.emitted === 2 &&
    s.worker.steps.sizing.totals.sized === 2 && s.worker.steps.dispatch.submitted === 2 && b.calls.submitOrder === 2,
    '3 decisions, 2 approved → 2 emitted/sized/dispatched; blocked one excluded');
});

// ─── E2E-03: fail-closed non-paper execConfig → throw, buildDecisions NOT called ─
await withEnv('e2e03', async () => {
  const b = fakeBroker({ accountOrThrow: okAccount() });
  let built = 0; const spyBuild = () => { built += 1; return []; };
  const threw = await threwAsync(() => runApprovedDecisionsPass({ runOutput, broker: b, execConfig: { ...PAPER_CFG, paper: false }, _buildDecisions: spyBuild }));
  check('E2E-03', threw === true && built === 0 && b.calls.submitOrder === 0,
    'non-paper execConfig → throw before build (no side effects, no submit)');
});

// ─── E2E-04: fail-closed broker without getAccount → throw, no build ──────────
await withEnv('e2e04', async () => {
  const b = fakeBroker({ noAccount: true });
  let built = 0; const spyBuild = () => { built += 1; return []; };
  const threw = await threwAsync(() => runApprovedDecisionsPass({ runOutput, broker: b, execConfig: PAPER_CFG, _buildDecisions: spyBuild }));
  check('E2E-04', threw === true && built === 0, 'broker without getAccount → throw before build (fail-closed)');
});

// ─── E2E-05: live mode → throw, no build ──────────────────────────────────────
await withEnv('e2e05', async () => {
  const b = fakeBroker({ accountOrThrow: okAccount() });
  let built = 0; const spyBuild = () => { built += 1; return []; };
  const threw = await threwAsync(() => runApprovedDecisionsPass({ runOutput, broker: b, execConfig: PAPER_CFG, mode: 'live', _buildDecisions: spyBuild }));
  check('E2E-05', threw === true && built === 0, 'mode=live → throw before build (fail-closed)');
});

// ─── E2E-06: missing runOutput → throw ───────────────────────────────────────
await withEnv('e2e06', async () => {
  const b = fakeBroker({ accountOrThrow: okAccount() });
  const threw = await threwAsync(() => runApprovedDecisionsPass({ broker: b, execConfig: PAPER_CFG, _buildDecisions: () => [] }));
  check('E2E-06', threw === true, 'missing runOutput → throw (fail-closed)');
});

// ─── E2E-07: account fetch fails → no dispatch, no submit, no throw ───────────
await withEnv('e2e07', async () => {
  const err = Object.assign(new Error('ECONNRESET'), { error_class: 'transient_network' });
  const b = fakeBroker({ accountOrThrow: () => { throw err; } });
  const fakeBuild = () => [dec({ symbol: 'AMAT', approved: true, i: '1' })];
  const s = await runApprovedDecisionsPass({ runOutput, broker: b, execConfig: PAPER_CFG, _buildDecisions: fakeBuild, run_id: 'run_e2e' });
  check('E2E-07',
    s.emitted === 1 && s.worker.steps.sizing.account_ok === false &&
    s.worker.steps.dispatch.skipped === true && s.worker.steps.dispatch.reason === 'sizing_account_not_ok' &&
    b.calls.submitOrder === 0,
    'account fetch fail → dispatch skipped(sizing_account_not_ok), no submit, summary returned (no throw)');
});

// ─── E2E-08: REAL normalizer + worker integration (only buildDecisions faked) ─
await withEnv('e2e08', async () => {
  const b = fakeBroker({ accountOrThrow: okAccount() });
  const fakeBuild = () => [dec({ symbol: 'AMAT', price_usd: 100, approved: true, i: '1' })];
  // no _approvedIntentsFromDecisions override → uses the REAL Unit-14 normalizer
  const s = await runApprovedDecisionsPass({ runOutput, broker: b, execConfig: PAPER_CFG, _buildDecisions: fakeBuild, run_id: 'run_e2e' });
  check('E2E-08',
    s.emitted === 1 && s.worker.steps.sizing.totals.sized === 1 && s.worker.steps.sizing.sized[0].symbol === 'AMAT' &&
    s.worker.steps.dispatch.submitted === 1,
    'real approvedIntentsFromDecisions + real worker pass integrate end-to-end (offline)');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\ne2e_paper_pass_step15_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
