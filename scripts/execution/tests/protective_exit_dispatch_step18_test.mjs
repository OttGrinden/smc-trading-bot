#!/usr/bin/env node
/**
 * ProtectiveExitDispatch — Phase 1 / Unit 18 tests (PED-01 … PED-08).
 *
 * Verifies routing of Unit-10.9 protective stop PLANS through the (Unit-17 stop-capable)
 * order_gateway: explicit protect_v1 cid preserved, stop_price_usd → stop_price mapped,
 * close-side, fail-closed on bad/missing stop data, idempotent across runs + in batch.
 *
 * Fully offline + deterministic: temp OrderStore + injected fake broker (captures the
 * forwarded broker request via toOrderReq). No network, no live.
 *
 * node scripts/execution/tests/protective_exit_dispatch_step18_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { dispatchProtectiveExits } from '../live_broker/protective_exit_dispatch.mjs';
import { buildProtectiveExits } from '../live_broker/protective_exit.mjs';
import { makeBrokerOrderRecord } from '../schemas.mjs';
import { _setOrderStorePaths, _clearOrderStorePaths, get as storeGet, upsert } from '../live_broker/order_store.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threw(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `protexitdisp_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
mkdirSync(ROOT, { recursive: true });

// Fake broker for the gateway: captures the forwarded orderReq (toOrderReq output).
function gatewayBroker() {
  const seen = { submit: [] };
  return {
    seen,
    async submitOrder(req) { seen.submit.push(req); return { provider: 'alpaca', client_order_id: req.client_order_id, broker_order_id: 'B_' + req.client_order_id, broker_status: 'accepted' }; },
    async getOrderByClientId() { return null; },
  };
}
function withStore(tag, fn) {
  const dir = join(ROOT, tag);
  mkdirSync(dir, { recursive: true });
  _setOrderStorePaths({ dir, eventsLog: join(dir, 'live_order_events.jsonl') });
  return Promise.resolve(fn()).finally(() => _clearOrderStorePaths());
}
// A protective plan in buildProtectiveExits().protected[] shape.
const plan = (over = {}) => ({
  symbol: 'AMAT', side: 'long', action: 'close', order_action: 'sell', quantity: 2,
  order_type: 'stop', stop_price_usd: 92, time_in_force: 'gtc', client_order_id: 'protect_v1_AMAT_long', ...over,
});

// ─── PED-01: valid plan → submitted; record + broker req carry stop + stop_price ─
await withStore('ped01', async () => {
  const b = gatewayBroker();
  const s = await dispatchProtectiveExits([plan()], { broker: b });
  const rec = storeGet('protect_v1_AMAT_long');
  const fwd = b.seen.submit[0];
  check('PED-01',
    s.submitted === 1 && s.results[0].status === 'submitted' &&
    rec.order_type === 'stop' && rec.stop_price === 92 && rec.action === 'close' &&
    fwd.order_type === 'stop' && fwd.stop_price === 92 && fwd.order_action === 'sell',
    'valid plan → submitted; record + broker req tragen stop + stop_price (close-side)');
});

// ─── PED-02: missing broker → throw (pre-flight) ────────────────────────────────
await withStore('ped02', async () => {
  const threwE = await threw(() => dispatchProtectiveExits([plan()], {}));
  check('PED-02', threwE === true, 'fehlender Broker → throw vor der Schleife (fail-closed)');
});

// ─── PED-03: invalid stop_price → skip, kein Submit ─────────────────────────────
await withStore('ped03', async () => {
  const b = gatewayBroker();
  const s = await dispatchProtectiveExits([plan({ stop_price_usd: 0 }), plan({ symbol: 'MU', client_order_id: 'protect_v1_MU_long', stop_price_usd: NaN })], { broker: b });
  check('PED-03',
    s.submitted === 0 && s.skipped === 2 && b.seen.submit.length === 0 &&
    s.results.every(r => r.reason === 'invalid_stop_price'),
    'stop_price 0/NaN → skip(invalid_stop_price), kein Submit (fail-closed)');
});

// ─── PED-04: idempotenz — bestehender Record + in-batch Duplikat ────────────────
await withStore('ped04', async () => {
  const b = gatewayBroker();
  // pre-seed a record at the protect cid (prior placement)
  upsert({ ...makeBrokerOrderRecord({ symbol: 'AMAT', side: 'long' }, {}, { client_order_id: 'protect_v1_AMAT_long', order_action: 'sell', qty: 2, order_type: 'stop', stop_price: 92 }), state: 'submitted' });
  const s1 = await dispatchProtectiveExits([plan()], { broker: b });
  // in-batch duplicate (two identical plans in one call)
  const s2 = await dispatchProtectiveExits([plan({ symbol: 'GD', side: 'short', order_action: 'buy_to_cover', client_order_id: 'protect_v1_GD_short' }), plan({ symbol: 'GD', side: 'short', order_action: 'buy_to_cover', client_order_id: 'protect_v1_GD_short' })], { broker: b });
  check('PED-04',
    s1.already_dispatched === 1 &&
    s2.submitted === 1 && s2.results.some(r => r.reason === 'duplicate_in_batch') &&
    b.seen.submit.length === 1 && b.seen.submit[0].client_order_id === 'protect_v1_GD_short',
    'bestehender Record → already_dispatched (kein 2. Submit); in-batch Duplikat → 1 submit (GD) + duplicate_in_batch');
});

// ─── PED-05: explizite protect_v1 cid wird bewahrt (nicht dispatch_v1) ──────────
await withStore('ped05', async () => {
  const b = gatewayBroker();
  await dispatchProtectiveExits([plan()], { broker: b });
  check('PED-05',
    b.seen.submit[0].client_order_id === 'protect_v1_AMAT_long' &&
    !b.seen.submit[0].client_order_id.startsWith('dispatch_v1'),
    'explizite protect_v1-cid bleibt erhalten (Idempotenz-Anker bewahrt)');
});

// ─── PED-06: stop_price_usd → stop_price exaktes Mapping, kein limit_price ──────
await withStore('ped06', async () => {
  const b = gatewayBroker();
  await dispatchProtectiveExits([plan({ stop_price_usd: 87.3456 })], { broker: b });
  const fwd = b.seen.submit[0];
  check('PED-06', fwd.stop_price === 87.3456 && !('limit_price' in fwd),
    'stop_price_usd → stop_price exakt gemappt; kein limit_price');
});

// ─── PED-07: fail-closed Feldguards (action/order_action/order_type/qty) ────────
await withStore('ped07', async () => {
  const b = gatewayBroker();
  const s = await dispatchProtectiveExits([
    plan({ action: 'open', client_order_id: 'protect_v1_a_long' }),                 // not_close_action
    plan({ order_action: 'buy', client_order_id: 'protect_v1_b_long' }),            // invalid_order_action
    plan({ order_type: 'market', client_order_id: 'protect_v1_c_long' }),          // not_stop_order_type
    plan({ quantity: 0, client_order_id: 'protect_v1_d_long' }),                    // invalid_quantity
  ], { broker: b });
  const reasons = s.results.map(r => r.reason);
  check('PED-07',
    s.submitted === 0 && b.seen.submit.length === 0 &&
    reasons.includes('not_close_action') && reasons.includes('invalid_order_action') &&
    reasons.includes('not_stop_order_type') && reasons.includes('invalid_quantity'),
    'open/buy/market/qty<=0 → je eigener fail-closed skip, kein Submit');
});

// ─── PED-08: END-TO-END — echter Planner → Dispatcher ──────────────────────────
await withStore('ped08', async () => {
  const b = gatewayBroker();
  const built = buildProtectiveExits([{ symbol: 'AMAT', side: 'long', quantity: 2, entry_price_usd: 100, stop_loss_pct: 8 }]);
  const s = await dispatchProtectiveExits(built.protected, { broker: b });
  const fwd = b.seen.submit[0];
  check('PED-08',
    built.totals.protected === 1 && s.submitted === 1 &&
    fwd.order_type === 'stop' && fwd.stop_price === 92 && fwd.order_action === 'sell' &&
    fwd.client_order_id === 'protect_v1_AMAT_long',
    'buildProtectiveExits → dispatchProtectiveExits: 1 submit, stop@92, sell, protect_v1 cid');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nprotective_exit_dispatch_step18_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
