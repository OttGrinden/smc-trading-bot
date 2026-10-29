#!/usr/bin/env node
/**
 * WorkerPass — Phase 1 / Unit 10.7 single-shot orchestrator tests (WP-01 … WP-08).
 *
 * Isolated + deterministic + offline:
 *   - temp OrderStore (_setOrderStorePaths) + temp lease (_setLeasePath)
 *   - temp portfolio state/ledger (_setTestPaths)
 *   - injected fake broker (submitOrder + getOrderByClientId) — no network
 *
 * node scripts/execution/tests/worker_pass_step10_7_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { acquireLease, _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { initPortfolio, loadOrInit, _setTestPaths, _clearTestPaths } from '../portfolio/portfolio_state.mjs';
import { runWorkerPassOnce } from '../live_broker/worker_pass.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

// Unique per invocation (pid can be recycled across runs; tmpdir is not auto-cleaned).
const ROOT = join(tmpdir(), `workerpass_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
mkdirSync(ROOT, { recursive: true });

const PAPER_CFG = Object.freeze({ enabled: true, mode: 'alpaca_paper', paper: true, base_url: 'https://paper-api.alpaca.markets', key_id: 'k', secret_key: 's' });

/**
 * Full isolated env. CRITICAL: the OrderStore dir and the portfolio dir MUST be
 * separate — order_store.listAll() scans every *.json in its dir, so a portfolio
 * state.json colocated there would be misread as an order record. Production keeps
 * them apart (live_orders/ vs portfolio/); the test mirrors that.
 */
async function withEnv(tag, initialState, fn) {
  const d = join(ROOT, tag);
  const ordersDir = join(d, 'orders');
  const pfDir     = join(d, 'portfolio');
  mkdirSync(ordersDir, { recursive: true });
  mkdirSync(pfDir, { recursive: true });
  const leaseP = join(ordersDir, '.paper_runner.lease');
  const statePath = join(pfDir, 'state.json');
  writeFileSync(statePath, JSON.stringify(initialState ?? initPortfolio(), null, 2) + '\n', 'utf8');
  const portfolioPaths = { state: statePath, history: join(pfDir, 'hist.jsonl'), ledger: join(pfDir, 'ledger.jsonl') };
  const apply = () => {
    _setOrderStorePaths({ dir: ordersDir, eventsLog: join(ordersDir, 'live_order_events.jsonl') });
    _setLeasePath(leaseP);
    _setTestPaths(portfolioPaths);
  };
  apply();
  const reloadState = () => { apply(); return loadOrInit(); };
  // MUST await fn before clearing: fn is async, so a sync try/finally would clear the
  // path overrides at the first await — sending the rest of the pass to PRODUCTION.
  try { return await fn({ dir: d, leaseP, statePath, reloadState }); }
  finally { _clearOrderStorePaths(); _clearLeasePath(); _clearTestPaths(); }
}

// Fake broker: submitOrder (dispatch) + getOrderByClientId (gate reconcile + cycle poll).
function fakeBroker({ submitFn, lookupFn } = {}) {
  const calls = { submitOrder: 0, getOrderByClientId: 0 };
  return {
    calls,
    async submitOrder(r) {
      calls.submitOrder += 1;
      if (typeof submitFn === 'function') return submitFn(r);
      return { provider: 'alpaca', client_order_id: r.client_order_id, broker_order_id: 'B_' + r.client_order_id, broker_status: 'accepted' };
    },
    async getOrderByClientId(cid) {
      calls.getOrderByClientId += 1;
      if (typeof lookupFn === 'function') return lookupFn(cid);
      return { provider: 'alpaca', broker_order_id: 'B_' + cid, broker_status: 'accepted', filled_qty: 0, avg_fill_price: null };
    },
  };
}

const sizedIntent = (over = {}) => ({
  symbol: 'AMAT', side: 'long', quantity: 3.6, run_id: 'run_wp', asset_type: 'stock',
  decision_source: { decision_id: 'd_AMAT', intent_id: 'i_AMAT' }, ...over,
});

// A fully FILLED open order record (for the end-to-end sync proof).
function filledOpenRecord(cid, { symbol = 'AMAT', side = 'long', qty = 2, px = 108 } = {}) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol, side, asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_prev', action: 'open', order_action: 'buy', qty },
  );
  return { ...r, state: 'filled', filled_qty: qty, remaining_qty: 0, avg_fill_price: px, last_applied_filled_qty: qty, terminal_at: '2026-06-18T08:00:00.000Z' };
}

// ─── WP-01: valid full pass → dispatch + cycle + sync, lease released ─────────────
await withEnv('wp01', null, async ({ leaseP, reloadState }) => {
  const b = fakeBroker();
  const s = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, approvedIntents: [sizedIntent()], run_id: 'run_wp' });
  const { existsSync } = await import('fs');
  check('WP-01',
    s.ran === true && s.reason === 'completed' &&
    s.steps.dispatch.submitted === 1 && s.steps.cycle.ran === true && s.steps.sync != null &&
    b.calls.submitOrder === 1 && !existsSync(leaseP),
    'full pass: 1 dispatch, cycle ran, sync ran, lease released');
});

// ─── WP-02: no-op (no intents, empty store) → ran true, dispatch skipped no_intents ─
await withEnv('wp02', null, async () => {
  const b = fakeBroker();
  const s = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, run_id: 'run_wp' });
  check('WP-02',
    s.ran === true && s.reason === 'completed' &&
    s.steps.dispatch.skipped === true && s.steps.dispatch.reason === 'no_intents' &&
    s.steps.sync.booked_open === 0 && b.calls.submitOrder === 0,
    'no intents + empty store → cycle ran, dispatch skipped(no_intents), nothing booked');
});

// ─── WP-03: gate unsafe (blocking submit_unknown) → abort, NO dispatch, NO sync ───
await withEnv('wp03', null, async () => {
  // seed a record that stays blocking: submit_unknown + broker returns null on lookup
  const rec = makeBrokerOrderRecord({ intent_id: 'i_x', symbol: 'AMAT', side: 'long' }, { decision_id: 'd_x' },
    { client_order_id: 'cid_su', run_id: 'run_p', action: 'open', order_action: 'buy', qty: 5 });
  upsert({ ...rec, state: 'submit_unknown' });
  const b = fakeBroker({ lookupFn: () => null });
  const s = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, approvedIntents: [sizedIntent()], run_id: 'run_wp' });
  check('WP-03',
    s.ran === false && s.reason === 'gate_unsafe' &&
    s.steps.dispatch.skipped === true && s.steps.dispatch.reason === 'gate_unsafe' &&
    s.steps.sync.skipped === true && b.calls.submitOrder === 0,
    'blocking submit_unknown → gate_unsafe, no dispatch, no sync, no submit');
});

// ─── WP-04: pre-flight fail-closed → throws on missing broker / non-paper config ──
await withEnv('wp04', null, async () => {
  const missingBroker = await threwAsync(() => runWorkerPassOnce({ execConfig: PAPER_CFG }));
  const nonPaper = await threwAsync(() => runWorkerPassOnce({ broker: fakeBroker(), execConfig: { ...PAPER_CFG, paper: false } }));
  check('WP-04', missingBroker === true && nonPaper === true,
    'missing broker throws; non-paper execConfig throws (fail-closed, pre-flight)');
});

// ─── WP-05: idempotent repeat → 2nd pass already_dispatched, submit called once ───
await withEnv('wp05', null, async () => {
  const b = fakeBroker();
  await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, approvedIntents: [sizedIntent()], run_id: 'run_wp' });
  const s2 = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, approvedIntents: [sizedIntent()], run_id: 'run_wp' });
  check('WP-05',
    b.calls.submitOrder === 1 && s2.steps.dispatch.already_dispatched === 1 && s2.ran === true,
    'second pass: already_dispatched, broker submitOrder total = 1 (no double dispatch)');
});

// ─── WP-06: foreign lease held → gate_unsafe back-off, no dispatch, no mutation ───
await withEnv('wp06', null, async ({ reloadState }) => {
  acquireLease({});   // plant a fresh "foreign" lease (held); gate cannot acquire → unsafe
  const b = fakeBroker();
  const s = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, approvedIntents: [sizedIntent()], run_id: 'run_wp' });
  const st = reloadState();
  check('WP-06',
    s.ran === false && s.reason === 'gate_unsafe' &&
    b.calls.submitOrder === 0 && st.open_positions.length === 0 && !('booked_fills' in st),
    'held lease → gate_unsafe, no submit, portfolio untouched (back-off when another writer active)');
});

// ─── WP-07: END-TO-END — a prior FILLED order record is booked into the portfolio ─
await withEnv('wp07', null, async ({ reloadState }) => {
  upsert(filledOpenRecord('cid_fill07', { symbol: 'AMAT', side: 'long', qty: 2, px: 108 }));  // 108 USD → 100 EUR
  const b = fakeBroker();
  const s = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, run_id: 'run_wp' });
  const st = reloadState();
  const pos = st.open_positions.find(p => p.symbol === 'AMAT' && p.side === 'long');
  check('WP-07',
    s.ran === true && s.steps.sync.booked_open === 1 &&
    pos && Math.abs(pos.entry_price_eur - 100) < 1e-3 && st.booked_fills['cid_fill07'] === 2,
    'prior FILLED record → orchestrator sync books AMAT long into portfolio (entry 100 EUR)');
});

// ─── WP-08: sync is idempotent across passes → no double booking ──────────────────
await withEnv('wp08', null, async ({ reloadState }) => {
  upsert(filledOpenRecord('cid_fill08', { symbol: 'MU', side: 'long', qty: 2, px: 108 }));
  const b = fakeBroker();
  await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, run_id: 'run_wp' });
  const afterFirst = reloadState();
  const s2 = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, run_id: 'run_wp' });
  const afterSecond = reloadState();
  check('WP-08',
    afterFirst.open_positions.length === 1 && s2.steps.sync.already_booked === 1 &&
    afterSecond.open_positions.length === 1,
    'repeat pass: filled record already_booked, no second position (sync idempotent)');
});

// ─── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nWorkerPass (Unit 10.7): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
