#!/usr/bin/env node
/**
 * WorkerPass account-sizing opt-in — Phase 1 / Unit 13 tests (WPS-01 … WPS-07).
 *
 * Verifies the opt-in sizing step wired into runWorkerPassOnce (ctx.sizeFromAccount):
 *   - on  → UNSIZED approved intents are sized via broker.getAccount() + account_sizing
 *           BEFORE dispatch; fail-closed on a failed/invalid account (no new dispatch).
 *   - off → byte-identical legacy path (approvedIntents already SIZED), getAccount untouched.
 *
 * Isolated + deterministic + offline (mirrors worker_pass_step10_7_test harness):
 *   - temp OrderStore (_setOrderStorePaths) + temp lease (_setLeasePath)
 *   - temp portfolio state/ledger (_setTestPaths)
 *   - injected fake broker (submitOrder + getOrderByClientId + getAccount) — no network
 *
 * node scripts/execution/tests/worker_pass_sizing_step13_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { initPortfolio, loadOrInit, _setTestPaths, _clearTestPaths } from '../portfolio/portfolio_state.mjs';
import { runWorkerPassOnce } from '../live_broker/worker_pass.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `wpsizing_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
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
  const portfolioPaths = { state: statePath, history: join(pfDir, 'hist.jsonl'), ledger: join(pfDir, 'ledger.jsonl') };
  const apply = () => {
    _setOrderStorePaths({ dir: ordersDir, eventsLog: join(ordersDir, 'live_order_events.jsonl') });
    _setLeasePath(leaseP);
    _setTestPaths(portfolioPaths);
  };
  apply();
  const reloadState = () => { apply(); return loadOrInit(); };
  try { return await fn({ dir: d, leaseP, reloadState }); }
  finally { _clearOrderStorePaths(); _clearLeasePath(); _clearTestPaths(); }
}

// Fake broker — accountOrThrow controls getAccount; omit getAccount entirely with noAccount=true.
function fakeBroker({ accountOrThrow, noAccount = false } = {}) {
  const calls = { submitOrder: 0, getOrderByClientId: 0, getAccount: 0 };
  const b = {
    calls,
    async submitOrder(r) {
      calls.submitOrder += 1;
      return { provider: 'alpaca', client_order_id: r.client_order_id, broker_order_id: 'B_' + r.client_order_id, broker_status: 'accepted' };
    },
    async getOrderByClientId(cid) {
      calls.getOrderByClientId += 1;
      return { provider: 'alpaca', broker_order_id: 'B_' + cid, broker_status: 'accepted', filled_qty: 0, avg_fill_price: null };
    },
  };
  if (!noAccount) {
    b.getAccount = async () => {
      calls.getAccount += 1;
      if (typeof accountOrThrow === 'function') return accountOrThrow();
      return accountOrThrow;
    };
  }
  return b;
}
const okAccount = (over = {}) => ({
  provider: 'alpaca', account_id: 'acct_1', currency: 'USD', status: 'ACTIVE',
  cash: 10000, buying_power: 10000, portfolio_value: 10000, equity: 10000, paper: true,
  ts: '2026-06-19T10:00:00.000Z', ...over,
});
// UNSIZED approved intent (price_usd, NO quantity) — the sizeFromAccount input shape.
const unsizedIntent = (over = {}) => ({
  symbol: 'AMAT', side: 'long', price_usd: 100, run_id: 'run_wps', asset_type: 'stock',
  decision_source: { decision_id: 'd_AMAT', intent_id: 'i_AMAT' }, ...over,
});
// SIZED intent (quantity, NO price_usd) — the legacy off-path shape.
const sizedIntent = (over = {}) => ({
  symbol: 'AMAT', side: 'long', quantity: 3.6, run_id: 'run_wps', asset_type: 'stock',
  decision_source: { decision_id: 'd_AMAT', intent_id: 'i_AMAT' }, ...over,
});

// ─── WPS-01: opt-in on + valid account → sized then dispatched ────────────────────
await withEnv('wps01', async () => {
  const b = fakeBroker({ accountOrThrow: okAccount() });
  const s = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, sizeFromAccount: true, approvedIntents: [unsizedIntent()], run_id: 'run_wps' });
  check('WPS-01',
    s.ran === true && s.steps.sizing.account_ok === true && s.steps.sizing.totals.sized === 1 &&
    s.steps.dispatch.submitted === 1 && b.calls.getAccount === 1 && b.calls.submitOrder === 1,
    'opt-in on: getAccount 1×, intent sized (1), dispatched (submitted 1)');
});

// ─── WPS-02: opt-in on + getAccount throws → no dispatch, cycle still runs ─────────
await withEnv('wps02', async () => {
  const err = Object.assign(new Error('ECONNRESET'), { error_class: 'transient_network' });
  const b = fakeBroker({ accountOrThrow: () => { throw err; } });
  const s = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, sizeFromAccount: true, approvedIntents: [unsizedIntent()], run_id: 'run_wps' });
  check('WPS-02',
    s.steps.sizing.account_ok === false && s.steps.sizing.account_reason === 'account_fetch_failed' &&
    s.steps.dispatch.skipped === true && s.steps.dispatch.reason === 'sizing_account_not_ok' &&
    b.calls.submitOrder === 0 && s.steps.cycle.ran === true,
    'fetch fail → no dispatch (sizing_account_not_ok), no submit, maintenance cycle still ran');
});

// ─── WPS-03: opt-in on + inactive account → no dispatch ───────────────────────────
await withEnv('wps03', async () => {
  const b = fakeBroker({ accountOrThrow: okAccount({ status: 'ACCOUNT_CLOSED' }) });
  const s = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, sizeFromAccount: true, approvedIntents: [unsizedIntent()], run_id: 'run_wps' });
  check('WPS-03',
    s.steps.sizing.account_ok === false && s.steps.sizing.account_reason === 'account_not_active' &&
    s.steps.dispatch.skipped === true && s.steps.dispatch.reason === 'sizing_account_not_ok' && b.calls.submitOrder === 0,
    'inactive account → no dispatch, no submit (fail-closed)');
});

// ─── WPS-04: opt-in on + broker without getAccount → pre-flight throw ─────────────
await withEnv('wps04', async () => {
  const b = fakeBroker({ noAccount: true });
  const threw = await threwAsync(() => runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, sizeFromAccount: true, approvedIntents: [unsizedIntent()], run_id: 'run_wps' }));
  check('WPS-04', threw === true && b.calls.submitOrder === 0,
    'sizeFromAccount=true + no getAccount → throw before any step (fail-closed)');
});

// ─── WPS-05: opt-in OFF (legacy) → sized intents dispatched, getAccount untouched ──
await withEnv('wps05', async () => {
  const b = fakeBroker({ noAccount: true });   // legacy broker need not expose getAccount
  const s = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, approvedIntents: [sizedIntent()], run_id: 'run_wps' });
  check('WPS-05',
    s.ran === true && s.steps.sizing.skipped === true && s.steps.sizing.reason === 'sizing_disabled' &&
    s.steps.dispatch.submitted === 1 && b.calls.getAccount === 0 && b.calls.submitOrder === 1,
    'opt-in off: legacy sized path, sizing skipped(disabled), getAccount never called');
});

// ─── WPS-06: opt-in on + account ok but 0 sized (below min) → dispatch skipped ────
await withEnv('wps06', async () => {
  const b = fakeBroker({ accountOrThrow: okAccount() });
  // max_position_notional below min_notional → target < min → skipped(below_min_notional), 0 sized
  const s = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, sizeFromAccount: true,
    sizingOpts: { max_position_notional_usd: 0.5, min_notional_usd: 1 },
    approvedIntents: [unsizedIntent()], run_id: 'run_wps' });
  check('WPS-06',
    s.steps.sizing.account_ok === true && s.steps.sizing.totals.sized === 0 &&
    s.steps.dispatch.skipped === true && s.steps.dispatch.reason === 'no_sized_intents' &&
    b.calls.submitOrder === 0 && s.steps.cycle.ran === true,
    'account ok but 0 sized → dispatch skipped(no_sized_intents), no submit, cycle ran');
});

// ─── WPS-07: opt-in on idempotent repeat → 2nd pass already_dispatched, submit once ─
await withEnv('wps07', async () => {
  const b = fakeBroker({ accountOrThrow: okAccount() });
  await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, sizeFromAccount: true, approvedIntents: [unsizedIntent()], run_id: 'run_wps' });
  const s2 = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, sizeFromAccount: true, approvedIntents: [unsizedIntent()], run_id: 'run_wps' });
  check('WPS-07',
    b.calls.submitOrder === 1 && s2.steps.dispatch.already_dispatched === 1 && s2.ran === true,
    'second sized pass: already_dispatched, submitOrder total = 1 (deterministic cid, no double dispatch)');
});

// ─── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nworker_pass_sizing_step13_test: ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
