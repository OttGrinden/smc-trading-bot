#!/usr/bin/env node
/**
 * Startup-Gate wiring into OrderGateway.submit — Phase 1 / Unit 10 (GW-01 … GW-07).
 *
 * Verifies the opt-in, fail-closed startup gate: when ctx.startupGate is enabled and
 * the gate is not unambiguously safe, NO new order is anchored or submitted. Default
 * (no ctx.startupGate) is byte-for-byte the pre-Unit-10 behavior.
 *
 * Isolated: temp OrderStore (_setOrderStorePaths) + temp lease (_setLeasePath) +
 * injected fake broker. Offline, no network.
 *
 * node scripts/execution/tests/startup_gate_wiring_step10_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync } from 'fs';
import { join }      from 'path';
import { tmpdir }    from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, get, exists, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { acquireLease, releaseLease, _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { submit } from '../live_broker/order_gateway.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const ROOT = join(tmpdir(), `gatewiring10_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

async function withEnv(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  const leaseP = join(d, '.paper_runner.lease');
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  _setLeasePath(leaseP);
  try { return await fn(d, leaseP); } finally { _clearOrderStorePaths(); _clearLeasePath(); }
}

const PAPER_CFG = Object.freeze({ enabled: true, mode: 'alpaca_paper', paper: true, base_url: 'https://paper-api.alpaca.markets', key_id: 'k', secret_key: 's' });

function seed(cid, over = {}) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: 'AMAT', side: 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_x', action: 'open', order_action: 'buy', qty: 10 },
  );
  upsert({ ...r, ...over });
}
function fakeBroker(getView) {
  const calls = { submitOrder: 0, getOrderByClientId: 0 };
  return {
    calls,
    async submitOrder(req)  { calls.submitOrder += 1; return { provider: 'alpaca', client_order_id: req.client_order_id, broker_order_id: 'NB_' + req.client_order_id, broker_status: 'accepted', filled_qty: 0, avg_fill_price: null }; },
    async getOrderByClientId(cid) { calls.getOrderByClientId += 1; const v = typeof getView === 'function' ? getView(cid) : getView; return v === undefined ? null : v; },
  };
}
const NEW_REQ = (cid = 'cid_new') => ({ client_order_id: cid, symbol: 'AMAT', qty: 5, order_action: 'buy', run_id: 'run_x', side: 'long' });

// ─── GW-01 (A): unsafe store → gate blocks; no submit, no anchor ──────────────
await withEnv('gw01', async () => {
  seed('cid_bad', { state: 'submit_unknown', broker_order_id: 'B' });   // broker won't know it → stays blocking
  const b = fakeBroker(undefined /* getOrderByClientId → null */);
  const r = await submit(NEW_REQ(), { broker: b, startupGate: { execConfig: PAPER_CFG } });
  check('GW-01',
    r.blocked_by_startup_gate === true && b.calls.submitOrder === 0 && !exists('cid_new'),
    'unsafe gate → blocked_by_startup_gate, broker.submitOrder NOT called, no pending_submit anchor');
});

// ─── GW-02 (B): clean store → gate safe → normal submit proceeds ──────────────
await withEnv('gw02', async () => {
  const b = fakeBroker(undefined);
  const r = await submit(NEW_REQ(), { broker: b, startupGate: { execConfig: PAPER_CFG } });
  check('GW-02',
    !r.blocked_by_startup_gate && r.state === 'submitted'
    && b.calls.submitOrder === 1 && get('cid_new').state === 'submitted',
    'safe gate → submit proceeds (one submitOrder, record submitted)');
});

// ─── GW-03 (C): lease not acquirable → fail-closed block ──────────────────────
await withEnv('gw03', async () => {
  const held = acquireLease({});                       // gate cannot acquire the single-writer lease
  const b = fakeBroker(undefined);
  const r = await submit(NEW_REQ(), { broker: b, startupGate: { execConfig: PAPER_CFG } });
  check('GW-03',
    r.blocked_by_startup_gate === true && b.calls.submitOrder === 0 && !exists('cid_new'),
    'lease held → gate fail-closed → submit blocked, no anchor');
  releaseLease(held.lease);
});

// ─── GW-04 (C2): invalid/non-paper config → fail-closed block ─────────────────
await withEnv('gw04', async () => {
  const b = fakeBroker(undefined);
  const r1 = await submit(NEW_REQ('cid_n1'), { broker: b, startupGate: { execConfig: { enabled: false, mode: 'off' } } });
  const r2 = await submit(NEW_REQ('cid_n2'), { broker: b, startupGate: { execConfig: { ...PAPER_CFG, paper: false } } });
  check('GW-04',
    r1.blocked_by_startup_gate === true && r2.blocked_by_startup_gate === true && b.calls.submitOrder === 0,
    'invalid + non-paper config → assertStartupGate fail-closed → blocked, no submit');
});

// ─── GW-05 (D): default OFF (no ctx.startupGate) → unchanged behavior ─────────
await withEnv('gw05', async () => {
  const b = fakeBroker(undefined);
  const r = await submit(NEW_REQ(), { broker: b });
  check('GW-05',
    !r.blocked_by_startup_gate && r.state === 'submitted'
    && b.calls.submitOrder === 1 && b.calls.getOrderByClientId === 0 && get('cid_new').state === 'submitted',
    'no startupGate → no gate path, no lease/getOrder IO, normal submit (zero regression)');
});

// ─── GW-06: injected gate function (unsafe) → blocked ─────────────────────────
await withEnv('gw06', async () => {
  const b = fakeBroker(undefined);
  const r = await submit(NEW_REQ(), { broker: b, startupGate: async () => ({ safe: false, gate: { reason: 'injected' } }) });
  check('GW-06',
    r.blocked_by_startup_gate === true && b.calls.submitOrder === 0 && !exists('cid_new'),
    'injected gate fn safe:false → blocked, no submit, no anchor');
});

// ─── GW-07: injected gate function (safe) → proceeds ──────────────────────────
await withEnv('gw07', async () => {
  const b = fakeBroker(undefined);
  const r = await submit(NEW_REQ(), { broker: b, startupGate: async () => ({ safe: true }) });
  check('GW-07',
    !r.blocked_by_startup_gate && r.state === 'submitted' && b.calls.submitOrder === 1,
    'injected gate fn safe:true → submit proceeds normally');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nstartup_gate_wiring_step10_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
