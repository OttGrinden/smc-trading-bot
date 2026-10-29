#!/usr/bin/env node
/**
 * OrderCancel + adapter.cancelOrder — Phase 1 / Unit 9a tests (CN-01 … CN-14).
 *
 * Isolated: temp OrderStore (_setOrderStorePaths) + injected fake broker. Offline.
 *
 * node scripts/execution/tests/cancel_step9_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync } from 'fs';
import { join }      from 'path';
import { tmpdir }    from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, get, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { requestCancel } from '../live_broker/order_cancel.mjs';
import { parseBrokerExecConfig } from '../live_broker/live_broker_config.mjs';
import { AlpacaPaperBroker, BrokerError, BROKER_ERROR_CLASSES } from '../live_broker/adapters/alpaca_paper_broker.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwClass(fn, cls) { try { await fn(); return false; } catch (e) { return e?.error_class === cls; } }

const ROOT = join(tmpdir(), `cancel9_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

async function withEnv(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  try { return await fn(d); } finally { _clearOrderStorePaths(); }
}

function seed(cid, state, over = {}) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: 'AMAT', side: 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_x', action: 'open', order_action: 'buy', qty: 10 },
  );
  upsert({ ...r, state, broker_order_id: 'B_' + cid, ...over });
}

// behavior(id, callIdx) → returns result, or returns an Error instance to be thrown.
function fakeCancelBroker(behavior) {
  const calls = [];
  return {
    calls,
    async cancelOrder(id) {
      calls.push(id);
      const r = typeof behavior === 'function' ? behavior(id, calls.length) : behavior;
      if (r instanceof Error) throw r;
      return r ?? { accepted: true, http_status: 204, broker_order_id: id };
    },
  };
}
const okBroker  = () => fakeCancelBroker(() => ({ accepted: true, http_status: 204 }));
const errBroker = (cls) => fakeCancelBroker(() => new BrokerError(cls, `forced ${cls}`));

// ─── CN-01: cancel from acknowledged → cancel_pending + exactly one DELETE ────
await withEnv('cn01', async () => {
  seed('cid_ack', 'acknowledged');
  const b = okBroker();
  const r = await requestCancel('cid_ack', { broker: b });
  check('CN-01',
    r.ok === true && r.outcome === 'cancel_requested' && get('cid_ack').state === 'cancel_pending'
    && b.calls.length === 1 && b.calls[0] === 'B_cid_ack',
    'acknowledged → cancel_pending, broker.cancelOrder(broker_order_id) once');
});

// ─── CN-02: cancel from submitted ─────────────────────────────────────────────
await withEnv('cn02', async () => {
  seed('cid_sub', 'submitted');
  const b = okBroker();
  const r = await requestCancel('cid_sub', { broker: b });
  check('CN-02', r.ok === true && get('cid_sub').state === 'cancel_pending' && b.calls.length === 1,
    'submitted → cancel_pending');
});

// ─── CN-03: cancel from partially_filled ──────────────────────────────────────
await withEnv('cn03', async () => {
  seed('cid_pf', 'partially_filled');
  const b = okBroker();
  const r = await requestCancel('cid_pf', { broker: b });
  check('CN-03', r.ok === true && get('cid_pf').state === 'cancel_pending' && b.calls.length === 1,
    'partially_filled → cancel_pending');
});

// ─── CN-04: terminal filled → abort, no broker call, state unchanged ──────────
await withEnv('cn04', async () => {
  seed('cid_fill', 'filled');
  const b = okBroker();
  const r = await requestCancel('cid_fill', { broker: b });
  check('CN-04',
    r.ok === false && r.outcome === 'not_cancelable_terminal'
    && get('cid_fill').state === 'filled' && b.calls.length === 0,
    'filled → fail-closed not_cancelable_terminal, no DELETE');
});

// ─── CN-05: already cancel_pending → idempotent no-op, no broker call ─────────
await withEnv('cn05', async () => {
  seed('cid_cp', 'cancel_pending');
  const b = okBroker();
  const r = await requestCancel('cid_cp', { broker: b });
  check('CN-05',
    r.ok === true && r.outcome === 'already_cancel_pending' && b.calls.length === 0,
    'cancel_pending → no-op ok, no DELETE');
});

// ─── CN-06: already cancelled → idempotent no-op ──────────────────────────────
await withEnv('cn06', async () => {
  seed('cid_cd', 'cancelled');
  const b = okBroker();
  const r = await requestCancel('cid_cd', { broker: b });
  check('CN-06',
    r.ok === true && r.outcome === 'already_cancelled' && b.calls.length === 0,
    'cancelled → no-op ok, no DELETE');
});

// ─── CN-07: transient broker error → reconcile_hold + cancel_unknown ──────────
await withEnv('cn07', async () => {
  seed('cid_tx', 'acknowledged');
  const b = errBroker(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK);
  const r = await requestCancel('cid_tx', { broker: b });
  const rec = get('cid_tx');
  check('CN-07',
    r.ok === false && r.outcome === 'held_unknown'
    && rec.state === 'reconcile_hold' && rec.reconcile_flag === 'cancel_unknown' && b.calls.length === 1,
    'transient → reconcile_hold + flag cancel_unknown (fail-closed)');
});

// ─── CN-08: 404 not_found → reconcile_hold + cancel_not_found ─────────────────
await withEnv('cn08', async () => {
  seed('cid_nf', 'acknowledged');
  const b = errBroker(BROKER_ERROR_CLASSES.NOT_FOUND);
  const r = await requestCancel('cid_nf', { broker: b });
  const rec = get('cid_nf');
  check('CN-08',
    r.ok === false && r.outcome === 'held_not_found'
    && rec.state === 'reconcile_hold' && rec.reconcile_flag === 'cancel_not_found',
    '404 → reconcile_hold + flag cancel_not_found (fail-closed)');
});

// ─── CN-09: 422 validation → stays cancel_pending + flag (poller resolves) ────
await withEnv('cn09', async () => {
  seed('cid_val', 'acknowledged');
  const b = errBroker(BROKER_ERROR_CLASSES.VALIDATION);
  const r = await requestCancel('cid_val', { broker: b });
  const rec = get('cid_val');
  check('CN-09',
    r.ok === false && r.outcome === 'flagged_not_cancelable'
    && rec.state === 'cancel_pending' && rec.reconcile_flag === 'cancel_rejected_not_cancelable',
    '422 → keep cancel_pending + flag (FillPoller fetches true terminal status)');
});

// ─── CN-10: uncertain state (submit_unknown) → not_cancelable_state, no call ──
await withEnv('cn10', async () => {
  seed('cid_su', 'submit_unknown');
  const b = okBroker();
  const r = await requestCancel('cid_su', { broker: b });
  check('CN-10',
    r.ok === false && r.outcome === 'not_cancelable_state'
    && get('cid_su').state === 'submit_unknown' && b.calls.length === 0,
    'submit_unknown → fail-closed not_cancelable_state, no DELETE (recover first)');
});

// ─── CN-11: cancelable state but no broker_order_id → reconcile_hold ──────────
await withEnv('cn11', async () => {
  seed('cid_nbid', 'acknowledged', { broker_order_id: null });
  const b = okBroker();
  const r = await requestCancel('cid_nbid', { broker: b });
  const rec = get('cid_nbid');
  check('CN-11',
    r.ok === false && r.outcome === 'held_missing_broker_id'
    && rec.state === 'reconcile_hold' && rec.reconcile_flag === 'cancel_missing_broker_id' && b.calls.length === 0,
    'missing broker_order_id → reconcile_hold, no DELETE (fail-closed)');
});

// ─── CN-12: idempotency — second cancel is a no-op, DELETE fired exactly once ─
await withEnv('cn12', async () => {
  seed('cid_idem', 'acknowledged');
  const b = okBroker();
  const r1 = await requestCancel('cid_idem', { broker: b });
  const r2 = await requestCancel('cid_idem', { broker: b });
  check('CN-12',
    r1.ok === true && r1.outcome === 'cancel_requested'
    && r2.ok === true && r2.outcome === 'already_cancel_pending'
    && b.calls.length === 1,
    'second requestCancel → no-op; broker DELETE fired exactly once');
});

// ─── CN-13: no local record → not_found_local, no broker call ─────────────────
await withEnv('cn13', async () => {
  const b = okBroker();
  const r = await requestCancel('cid_ghost', { broker: b });
  check('CN-13', r.ok === false && r.outcome === 'not_found_local' && b.calls.length === 0,
    'unknown cid → not_found_local, no DELETE');
});

// ─── CN-14: adapter cancelOrder — DELETE shape + status classification ────────
{
  const PAPER_CFG = parseBrokerExecConfig(['--broker-exec', 'alpaca_paper'], { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' });
  const mk = (responder) => {
    const calls = [];
    const http = async (req) => { calls.push(req); return responder(req); };
    return { broker: new AlpacaPaperBroker(PAPER_CFG, { httpRequest: http }), calls };
  };

  // 204 success
  const okc = mk(() => ({ statusCode: 204, json: null, text: '' }));
  const okRes = await okc.broker.cancelOrder('B1');
  const okShape = okc.calls[0].method === 'DELETE' && okc.calls[0].url.endsWith('/v2/orders/B1')
    && okRes.accepted === true && okRes.http_status === 204;

  // 404 → not_found, 422 → validation, network → transient_network, missing id → validation (no call)
  const nf  = mk(() => ({ statusCode: 404, json: { message: 'order not found' } }));
  const val = mk(() => ({ statusCode: 422, json: { message: 'order is not cancelable' } }));
  const net = mk(() => { throw new Error('ECONNRESET'); });
  const novalid = mk(() => ({ statusCode: 204 }));

  const ok =
    okShape
    && (await threwClass(() => nf.broker.cancelOrder('B1'),  BROKER_ERROR_CLASSES.NOT_FOUND))
    && (await threwClass(() => val.broker.cancelOrder('B1'), BROKER_ERROR_CLASSES.VALIDATION))
    && (await threwClass(() => net.broker.cancelOrder('B1'), BROKER_ERROR_CLASSES.TRANSIENT_NETWORK))
    && (await threwClass(() => novalid.broker.cancelOrder(''), BROKER_ERROR_CLASSES.VALIDATION))
    && novalid.calls.length === 0;
  check('CN-14', ok,
    'DELETE /v2/orders/{id}; 204→accepted, 404→not_found, 422→validation, net→transient, empty id→validation (no call)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\ncancel_step9_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
