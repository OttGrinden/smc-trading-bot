#!/usr/bin/env node
/**
 * OrderReplace (cancel-and-recreate) — Phase 1 / Unit 9b tests (RP-01 … RP-13).
 *
 * Isolated: temp OrderStore (_setOrderStorePaths) + injected fake broker. Offline.
 * Core assertion: the RECREATE GATE — a new order is submitted ONLY when the old
 * order is locally `cancelled`; never before, and never twice.
 *
 * node scripts/execution/tests/replace_step9_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync } from 'fs';
import { join }      from 'path';
import { tmpdir }    from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, get, exists, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { requestReplace } from '../live_broker/order_replace.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `replace9_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

async function withEnv(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  try { return await fn(d); } finally { _clearOrderStorePaths(); }
}

function seedOld(cid, state, over = {}) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: 'AMAT', side: 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_x', action: 'open', order_action: 'buy', qty: 10 },
  );
  upsert({ ...r, state, broker_order_id: 'B_' + cid, ...over });
}

function fakeBroker() {
  const calls = { cancelOrder: [], submitOrder: [], getOrderByClientId: [] };
  return {
    calls,
    async cancelOrder(id)   { calls.cancelOrder.push(id);   return { accepted: true, http_status: 204 }; },
    async submitOrder(req)  { calls.submitOrder.push(req);  return { provider: 'alpaca', client_order_id: req.client_order_id, broker_order_id: 'NB_' + req.client_order_id, broker_status: 'accepted', filled_qty: 0, avg_fill_price: null }; },
    async getOrderByClientId(cid) { calls.getOrderByClientId.push(cid); return null; },
  };
}

const NEW_REQ = (over = {}) => ({ client_order_id: 'cid_new', symbol: 'AMAT', qty: 5, order_action: 'buy', run_id: 'run_x', side: 'long', ...over });

// ─── RP-01: old submitted → cycle A: cancel underway, NO recreate ─────────────
await withEnv('rp01', async () => {
  seedOld('cid_old', 'submitted');
  const b = fakeBroker();
  const r = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-01',
    r.ok === true && r.outcome === 'awaiting_cancel'
    && get('cid_old').state === 'cancel_pending' && get('cid_old').replaced_by_cid === 'cid_new'
    && b.calls.cancelOrder.length === 1 && b.calls.submitOrder.length === 0 && !exists('cid_new'),
    'submitted → cancel requested, linkage set, NO new order (recreate gate)');
});

// ─── RP-02: old cancel_pending → still awaiting, NO recreate ──────────────────
await withEnv('rp02', async () => {
  seedOld('cid_old', 'cancel_pending');
  const b = fakeBroker();
  const r = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-02',
    r.ok === true && r.outcome === 'awaiting_cancel'
    && b.calls.submitOrder.length === 0 && !exists('cid_new'),
    'cancel_pending → awaiting, recreate still gated (no submit)');
});

// ─── RP-03: old reconcile_hold → blocked, no action ───────────────────────────
await withEnv('rp03', async () => {
  seedOld('cid_old', 'reconcile_hold');
  const b = fakeBroker();
  const r = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-03',
    r.ok === false && r.outcome === 'blocked_uncertain_state'
    && b.calls.cancelOrder.length === 0 && b.calls.submitOrder.length === 0,
    'reconcile_hold → fail-closed blocked, no cancel, no recreate');
});

// ─── RP-04: old submit_unknown → blocked ──────────────────────────────────────
await withEnv('rp04', async () => {
  seedOld('cid_old', 'submit_unknown');
  const b = fakeBroker();
  const r = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-04',
    r.ok === false && r.outcome === 'blocked_uncertain_state' && b.calls.submitOrder.length === 0,
    'submit_unknown → fail-closed blocked, no recreate');
});

// ─── RP-05: old cancelled → RECREATE exactly one new order ────────────────────
await withEnv('rp05', async () => {
  seedOld('cid_old', 'cancelled');
  const b = fakeBroker();
  const r = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-05',
    r.ok === true && r.outcome === 'recreated' && r.new_cid === 'cid_new'
    && b.calls.submitOrder.length === 1 && exists('cid_new')
    && get('cid_new').state === 'submitted' && get('cid_new').replaces_cid === 'cid_old'
    && get('cid_old').replaced_by_cid === 'cid_new',
    'cancelled → recreate: one submit, new submitted, bidirectional linkage');
});

// ─── RP-06: recreate is idempotent — submit fires exactly once on re-call ─────
await withEnv('rp06', async () => {
  seedOld('cid_old', 'cancelled');
  const b = fakeBroker();
  const r1 = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  const r2 = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-06',
    r1.outcome === 'recreated' && r2.outcome === 'recreated' && b.calls.submitOrder.length === 1,
    'second call → recreated (idempotent); broker submit fired exactly once');
});

// ─── RP-07: old partially_filled → abort, no recreate ─────────────────────────
await withEnv('rp07', async () => {
  seedOld('cid_old', 'partially_filled');
  const b = fakeBroker();
  const r = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-07',
    r.ok === false && r.outcome === 'aborted_old_filled'
    && b.calls.cancelOrder.length === 0 && b.calls.submitOrder.length === 0 && !exists('cid_new'),
    'partially_filled → abort, no cancel, no recreate');
});

// ─── RP-08: old filled → abort ────────────────────────────────────────────────
await withEnv('rp08', async () => {
  seedOld('cid_old', 'filled');
  const b = fakeBroker();
  const r = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-08',
    r.ok === false && r.outcome === 'aborted_old_filled' && b.calls.submitOrder.length === 0,
    'filled → abort, no recreate');
});

// ─── RP-09: full two-cycle flow — recreate blocked until cancelled, then fires ─
await withEnv('rp09', async () => {
  seedOld('cid_old', 'submitted');
  const b = fakeBroker();
  // Cycle A: cancel underway, no recreate
  const a = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  const afterA = { submits: b.calls.submitOrder.length, newExists: exists('cid_new'), oldState: get('cid_old').state };
  // Simulate the FillPoller terminalizing the cancel old → cancelled
  upsert({ ...get('cid_old'), state: 'cancelled', terminal_at: new Date().toISOString() });
  // Cycle B: now recreate fires
  const c = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-09',
    a.outcome === 'awaiting_cancel' && afterA.submits === 0 && afterA.newExists === false && afterA.oldState === 'cancel_pending'
    && c.outcome === 'recreated' && b.calls.submitOrder.length === 1 && get('cid_new').state === 'submitted',
    'two cycles: A awaits cancel (no submit); after cancelled, B recreates exactly once');
});

// ─── RP-10: linkage mismatch on retry → fail-closed ───────────────────────────
await withEnv('rp10', async () => {
  seedOld('cid_old', 'cancelled', { replaced_by_cid: 'cid_other' });
  const b = fakeBroker();
  const r = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-10',
    r.ok === false && r.outcome === 'replace_cid_mismatch' && b.calls.submitOrder.length === 0,
    'different new cid than already linked → fail-closed, no recreate');
});

// ─── RP-11: old terminal but not cancelled (rejected) → no recreate ───────────
await withEnv('rp11', async () => {
  seedOld('cid_old', 'rejected');
  const b = fakeBroker();
  const r = await requestReplace('cid_old', NEW_REQ(), { broker: b });
  check('RP-11',
    r.ok === false && r.outcome === 'old_terminal_not_cancelled' && b.calls.submitOrder.length === 0,
    'rejected → recreate gate closed (only cancelled qualifies)');
});

// ─── RP-12: old not found ─────────────────────────────────────────────────────
await withEnv('rp12', async () => {
  const b = fakeBroker();
  const r = await requestReplace('cid_ghost', NEW_REQ(), { broker: b });
  check('RP-12', r.ok === false && r.outcome === 'old_not_found' && b.calls.submitOrder.length === 0,
    'unknown old cid → old_not_found, no recreate');
});

// ─── RP-13: argument validation (fail-closed) ─────────────────────────────────
await withEnv('rp13', async () => {
  seedOld('cid_old', 'cancelled');
  const b = fakeBroker();
  const ok =
    (await threwAsync(() => requestReplace('cid_old', { symbol: 'X', qty: 1, order_action: 'buy' }, { broker: b })))   // no new cid
    && (await threwAsync(() => requestReplace('cid_old', NEW_REQ({ client_order_id: 'cid_old' }), { broker: b })))      // new == old
    && (await threwAsync(() => requestReplace('cid_old', NEW_REQ(), { broker: {} })));                                  // broker missing methods
  check('RP-13', ok && b.calls.submitOrder.length === 0,
    'missing new cid / new==old / incomplete broker → throws, no recreate');
});

// ─── RP-14: recreate blocked by startup gate → explicit gate-aware return ─────
await withEnv('rp14', async () => {
  seedOld('cid_old', 'cancelled');
  const b = fakeBroker();
  const r = await requestReplace('cid_old', NEW_REQ(),
    { broker: b, startupGate: async () => ({ safe: false, gate: { reason: 'injected' } }) });
  check('RP-14',
    r.ok === false && r.blocked_by_startup_gate === true && r.phase === 'recreate'
    && r.outcome === 'recreate_blocked_by_gate'
    && r.new_cid === 'cid_new' && r.new_client_order_id === 'cid_new' && r.new_state === null
    && b.calls.submitOrder.length === 0 && !exists('cid_new')
    && get('cid_old').state === 'cancelled' && get('cid_old').replaced_by_cid === 'cid_new',
    'recreate gate-blocked → ok:false, phase=recreate, no submit, no anchor, old stays cancelled (intent kept)');
});

// ─── RP-15: retry after a gate-block with safe gate → recreate exactly once ───
await withEnv('rp15', async () => {
  seedOld('cid_old', 'cancelled');
  const b = fakeBroker();
  const blocked = await requestReplace('cid_old', NEW_REQ(), { broker: b, startupGate: async () => ({ safe: false }) });
  const after   = await requestReplace('cid_old', NEW_REQ(), { broker: b, startupGate: async () => ({ safe: true }) });
  check('RP-15',
    blocked.ok === false && blocked.blocked_by_startup_gate === true
    && after.ok === true && after.outcome === 'recreated' && after.new_state === 'submitted'
    && after.new_client_order_id === 'cid_new'
    && b.calls.submitOrder.length === 1 && exists('cid_new') && get('cid_new').state === 'submitted',
    'gate-block then safe retry → recreated exactly once (no double submit)');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nreplace_step9_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
