#!/usr/bin/env node
/**
 * OrderDispatch — Phase 1 / Unit 10.6 tests (OD-01 … OD-12).
 *
 * Isolated + deterministic + offline:
 *   - order records live in a temp store dir (_setOrderStorePaths)
 *   - a fake INJECTED broker (ctx.broker) — no real broker IO, no network
 *   - no portfolio state is touched at all (dispatch never mutates the portfolio)
 *
 * node scripts/execution/tests/order_dispatch_step10_6_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { join }      from 'path';
import { tmpdir }    from 'os';
import { mkdirSync } from 'fs';

import { get, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { dispatchApproved }                                from '../live_broker/order_dispatch.mjs';
import { BrokerError, BROKER_ERROR_CLASSES }               from '../live_broker/adapters/alpaca_paper_broker.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `orderdispatch_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

async function withStore(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  try { return await fn(d); } finally { _clearOrderStorePaths(); }
}

// Fake broker: programmable + call counting (same pattern as the gateway test).
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
      return null;
    },
  };
}

// An allocation-shaped, approved + sized intent.
const sized = (over = {}) => ({
  symbol: 'AMAT', side: 'long', quantity: 3.6, run_id: 'run_x', asset_type: 'stock',
  decision_source: { decision_id: 'd_AMAT', intent_id: 'i_AMAT' }, ...over,
});

// ─── OD-01: valid open long → one submit, deterministic cid, broker_order_id ──────
await withStore('od01', async () => {
  const b = fakeBroker();
  const sum = await dispatchApproved([sized()], { broker: b });
  const r = sum.results[0];
  check('OD-01',
    sum.submitted === 1 && b.calls.submitOrder === 1 &&
    r.status === 'submitted' && r.client_order_id === 'dispatch_v1_run_x_AMAT_long_buy' &&
    r.broker_order_id === 'B_dispatch_v1_run_x_AMAT_long_buy',
    'open long → 1 submit, cid=dispatch_v1_run_x_AMAT_long_buy, broker_order_id set');
});

// ─── OD-02: valid open short → order_action sell_short ────────────────────────────
await withStore('od02', async () => {
  const b = fakeBroker();
  const sum = await dispatchApproved([sized({ symbol: 'TSLA', side: 'short' })], { broker: b });
  const stored = get('dispatch_v1_run_x_TSLA_short_sell_short');
  check('OD-02',
    sum.submitted === 1 && stored && stored.order_action === 'sell_short' && stored.side === 'short',
    'open short → order_action sell_short persisted');
});

// ─── OD-03: cross-call idempotency → 2nd dispatch is already_dispatched, no 2nd POST ─
await withStore('od03', async () => {
  const b = fakeBroker();
  await dispatchApproved([sized()], { broker: b });
  const sum2 = await dispatchApproved([sized()], { broker: b });
  const r = sum2.results[0];
  check('OD-03',
    b.calls.submitOrder === 1 && sum2.already_dispatched === 1 && r.status === 'already_dispatched',
    'second dispatch of same intent → already_dispatched, broker submitOrder still 1');
});

// ─── OD-04: in-batch duplicate → exactly one submit + one duplicate_in_batch ──────
await withStore('od04', async () => {
  const b = fakeBroker();
  const sum = await dispatchApproved([sized(), sized()], { broker: b });
  check('OD-04',
    b.calls.submitOrder === 1 && sum.submitted === 1 && sum.skipped === 1 &&
    sum.results.some(r => r.reason === 'duplicate_in_batch'),
    'two identical items in one call → 1 submit, 1 duplicate_in_batch');
});

// ─── OD-05: invalid items → skipped with reasons, NO submit at all ────────────────
await withStore('od05', async () => {
  const b = fakeBroker();
  const sum = await dispatchApproved([
    sized({ symbol: '' }),                 // missing_symbol
    sized({ side: 'flat' }),               // invalid_side
    sized({ quantity: 0 }),                // invalid_quantity
    sized({ run_id: null }),               // missing_run_id (no ctx.run_id)
  ], { broker: b });
  const reasons = sum.results.map(r => r.reason).sort();
  check('OD-05',
    b.calls.submitOrder === 0 && sum.skipped === 4 && sum.submitted === 0 &&
    JSON.stringify(reasons) === JSON.stringify(['invalid_quantity', 'invalid_side', 'missing_run_id', 'missing_symbol']),
    'invalid intents → 4 skips, zero submits');
});

// ─── OD-06: ambiguous action → fail-closed skip(invalid_action), no submit ────────
await withStore('od06', async () => {
  const b = fakeBroker();
  const sum = await dispatchApproved([sized({ action: 'rebalance' })], { broker: b });
  check('OD-06',
    b.calls.submitOrder === 0 && sum.skipped === 1 && sum.results[0].reason === 'invalid_action',
    'unknown action → skip(invalid_action), no submit');
});

// ─── OD-07: close long → order_action sell ────────────────────────────────────────
await withStore('od07', async () => {
  const b = fakeBroker();
  const sum = await dispatchApproved([sized({ action: 'close' })], { broker: b });
  const stored = get('dispatch_v1_run_x_AMAT_long_sell');
  check('OD-07',
    sum.submitted === 1 && stored && stored.order_action === 'sell' && stored.action === 'close',
    'close long → order_action sell persisted');
});

// ─── OD-08: startup gate blocks → blocked_by_gate, no anchor, no submit ───────────
await withStore('od08', async () => {
  const b = fakeBroker();
  const sum = await dispatchApproved([sized()], {
    broker: b, startupGate: () => ({ safe: false, exit_code: 2, gate: { reason: 'unsafe' } }),
  });
  check('OD-08',
    b.calls.submitOrder === 0 && sum.blocked_by_gate === 1 &&
    sum.results[0].status === 'blocked_by_gate' && get('dispatch_v1_run_x_AMAT_long_buy') === null,
    'startup gate unsafe → blocked_by_gate, no POST, no anchor persisted');
});

// ─── OD-09: broker VALIDATION error → gateway rejects → status rejected ───────────
await withStore('od09', async () => {
  const b = fakeBroker({ submitFn: () => { throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, 'bad', 422); } });
  const sum = await dispatchApproved([sized()], { broker: b });
  check('OD-09',
    sum.rejected === 1 && sum.results[0].status === 'rejected' && sum.results[0].state === 'rejected',
    'broker validation error → rejected (terminal, no retry)');
});

// ─── OD-10: transient network error → submit_uncertain (recoverable) ──────────────
await withStore('od10', async () => {
  const b = fakeBroker({ submitFn: () => { throw new BrokerError(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK, 'net', 0); } });
  const sum = await dispatchApproved([sized()], { broker: b });
  check('OD-10',
    sum.submit_uncertain === 1 && sum.results[0].status === 'submit_uncertain' &&
    sum.results[0].state === 'submit_unknown',
    'transient network → submit_uncertain (submit_unknown, reconciler resolves later)');
});

// ─── OD-11: allocation-shaped item (no action, decision_source) → provenance kept ─
await withStore('od11', async () => {
  const b = fakeBroker();
  // run_id from ctx, quantity field, decision_source provenance, no explicit action
  const sum = await dispatchApproved(
    [{ symbol: 'MU', side: 'long', quantity: 1.5, decision_source: { decision_id: 'dec_MU', intent_id: 'int_MU' } }],
    { broker: b, run_id: 'run_ctx' },
  );
  const stored = get('dispatch_v1_run_ctx_MU_long_buy');
  check('OD-11',
    sum.submitted === 1 && stored &&
    stored.decision_id === 'dec_MU' && stored.intent_id === 'int_MU' &&
    stored.qty === 1.5 && stored.action === 'open',
    'allocation-shaped item → open dispatched, run_id from ctx, decision/intent provenance persisted');
});

// ─── OD-12: mixed batch → only valid items submit; counts exact; no broker w/o ctx ─
await withStore('od12', async () => {
  // missing broker → throws before the loop (programming error, fail-closed)
  const threw = await threwAsync(() => dispatchApproved([sized()], {}));
  const b = fakeBroker();
  const sum = await dispatchApproved([
    sized({ symbol: 'AAA', side: 'long' }),   // valid
    sized({ symbol: '' }),                    // skip
    sized({ symbol: 'BBB', side: 'short' }),  // valid
  ], { broker: b });
  check('OD-12',
    threw === true && b.calls.submitOrder === 2 && sum.submitted === 2 && sum.skipped === 1 && sum.total === 3,
    'missing broker throws; mixed batch → 2 submits, 1 skip, total 3');
});

// ─── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nOrderDispatch (Unit 10.6): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
