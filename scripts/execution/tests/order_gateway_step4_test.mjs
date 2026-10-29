#!/usr/bin/env node
/**
 * OrderGateway — Phase 1 / Unit 4 submit-orchestration tests (AG-01 … AG-15).
 *
 * Isolated: every case uses a temp OrderStore dir via _setOrderStorePaths and a
 * fake INJECTED broker (ctx.broker). No live order store, NO real broker IO, no network.
 *
 * node scripts/execution/tests/order_gateway_step4_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { readFileSync } from 'fs';
import { join }         from 'path';
import { tmpdir }       from 'os';
import { mkdirSync }    from 'fs';

import {
  get, listAll,
  _setOrderStorePaths, _clearOrderStorePaths,
} from '../live_broker/order_store.mjs';
import { submit }                            from '../live_broker/order_gateway.mjs';
import { BrokerError, BROKER_ERROR_CLASSES } from '../live_broker/adapters/alpaca_paper_broker.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `ordergateway_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

async function withStore(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  try { return await fn(d); } finally { _clearOrderStorePaths(); }
}
function events(d) {
  try { return readFileSync(join(d, 'live_order_events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); }
  catch { return []; }
}

// A minimal valid order request (explicit cid for deterministic assertions).
const req = (cid, over = {}) => ({
  client_order_id: cid, symbol: 'AMAT', qty: 3.6, side: 'long',
  order_action: 'buy', order_type: 'market', time_in_force: 'day',
  run_id: 'run_x', intent_id: 'i_' + cid, decision_id: 'd_' + cid, action: 'open', ...over,
});

// Fake broker: programmable behavior + call counting; observes persisted state at IO time.
function fakeBroker({ submitFn, lookupFn } = {}) {
  const calls = { submitOrder: 0, getOrderByClientId: 0, stateAtSubmit: null, anchorTsAtSubmit: undefined };
  return {
    calls,
    async submitOrder(r) {
      calls.submitOrder += 1;
      const stored = get(r.client_order_id);
      calls.stateAtSubmit    = stored?.state ?? null;
      calls.anchorTsAtSubmit = stored?.anchor_persisted_at;
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
const throwsClass = (klass) => () => { throw new BrokerError(klass, `simulated ${klass}`, 422); };

// ─── AG-01: success persists pending_submit THEN submitted (event order) ──────────
await withStore('ag01', (d) => {
  const b = fakeBroker();
  return submit(req('cid_ag01'), { broker: b }).then(rec => {
    const evTypes = events(d).map(e => e.type);
    check('AG-01',
      rec.state === 'submitted'
      && evTypes.join(',') === 'broker_submit_anchor_persisted,broker_order_submitted'
      && b.calls.submitOrder === 1,
      'success: anchor(pending_submit) then submitted; events in order; exactly 1 POST');
  });
});

// ─── AG-02: anchor (pending_submit + anchor_persisted_at) persisted BEFORE broker IO ─
await withStore('ag02', () => {
  const b = fakeBroker();
  return submit(req('cid_ag02'), { broker: b }).then(() => {
    check('AG-02',
      b.calls.stateAtSubmit === 'pending_submit' && typeof b.calls.anchorTsAtSubmit === 'string',
      'broker.submitOrder saw a persisted pending_submit anchor with anchor_persisted_at (write-before-IO)');
  });
});

// ─── AG-03: success adopts broker_order_id / broker_status / submitted_at ─────────
await withStore('ag03', () => {
  const b = fakeBroker({ submitFn: (r) => ({ broker_order_id: 'B_xyz', broker_status: 'new', client_order_id: r.client_order_id }) });
  return submit(req('cid_ag03'), { broker: b }).then(rec => {
    const s = get('cid_ag03');
    check('AG-03',
      rec.broker_order_id === 'B_xyz' && rec.broker_status === 'new' && typeof rec.submitted_at === 'string'
      && s.idempotency_status === 'submitted' && s.attempt_count === 1,
      'broker_order_id/broker_status/submitted_at written; idempotency_status=submitted, attempt_count=1');
  });
});

// ─── AG-04: duplicate_client_order_id → getOrderByClientId adoption, NO 2nd submit ─
await withStore('ag04', () => {
  const b = fakeBroker({
    submitFn: throwsClass(BROKER_ERROR_CLASSES.DUPLICATE_CLIENT_ORDER_ID),
    lookupFn: (cid) => ({ client_order_id: cid, broker_order_id: 'B_existing', broker_status: 'new' }),
  });
  return submit(req('cid_ag04'), { broker: b }).then(rec => {
    check('AG-04',
      rec.state === 'submitted' && rec.broker_order_id === 'B_existing' && rec.idempotency_status === 'adopted'
      && b.calls.submitOrder === 1 && b.calls.getOrderByClientId === 1,
      'duplicate → adopt via getOrderByClientId (idempotency_status=adopted), single submit');
  });
});

// ─── AG-05: duplicate + lookup not found (null) → fail-closed submit_unknown ──────
await withStore('ag05', () => {
  const b = fakeBroker({ submitFn: throwsClass(BROKER_ERROR_CLASSES.DUPLICATE_CLIENT_ORDER_ID), lookupFn: () => null });
  return submit(req('cid_ag05'), { broker: b }).then(rec => {
    check('AG-05',
      rec.state === 'submit_unknown' && rec.reconcile_flag === 'duplicate_but_not_found'
      && rec.broker_order_id === null,
      'duplicate-but-404 → fail-closed submit_unknown + reconcile_flag (not optimistic)');
  });
});

// ─── AG-06: transient_network / unclear outcome → submit_unknown ─────────────────
await withStore('ag06', () => {
  const b = fakeBroker({ submitFn: throwsClass(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK) });
  return submit(req('cid_ag06'), { broker: b }).then(rec => {
    check('AG-06',
      rec.state === 'submit_unknown' && rec.error?.error_class === 'transient_network'
      && get('cid_ag06').idempotency_status === 'submit_unknown',
      'transient_network → submit_unknown with error diagnostics');
  });
});

// ─── AG-07: validation error → rejected, NO blind retry (single submit, terminal) ─
await withStore('ag07', async () => {
  const b = fakeBroker({ submitFn: throwsClass(BROKER_ERROR_CLASSES.VALIDATION) });
  const r1 = await submit(req('cid_ag07'), { broker: b });
  const r2 = await submit(req('cid_ag07'), { broker: b });   // re-entry must not resubmit
  check('AG-07',
    r1.state === 'rejected' && r1.error?.error_class === 'validation'
    && b.calls.submitOrder === 1 && r2.state === 'rejected',
    'validation → rejected (terminal); re-entry is no-op, no 2nd submit');
});

// ─── AG-08: auth error → rejected, classified/persisted cleanly ──────────────────
await withStore('ag08', () => {
  const b = fakeBroker({ submitFn: throwsClass(BROKER_ERROR_CLASSES.AUTH) });
  return submit(req('cid_ag08'), { broker: b }).then(rec => {
    check('AG-08',
      rec.state === 'rejected' && rec.error?.error_class === 'auth' && typeof rec.terminal_at === 'string',
      'auth → rejected, error_class persisted, terminal_at set (conservative, no auto-retry)');
  });
});

// ─── AG-09: event log append-only + sensible order for the submit_unknown path ────
await withStore('ag09', (d) => {
  const b = fakeBroker({ submitFn: throwsClass(BROKER_ERROR_CLASSES.BROKER_INTERNAL) });
  return submit(req('cid_ag09'), { broker: b }).then(() => {
    const ev = events(d);
    check('AG-09',
      ev.length === 2 && ev[0].type === 'broker_submit_anchor_persisted' && ev[1].type === 'broker_submit_unknown'
      && ev.every(e => e.client_order_id === 'cid_ag09' && typeof e.ts === 'string')
      && ev[1].error_class === 'broker_internal',
      'append-only events: anchor then submit_unknown; client_order_id + ts on every line');
  });
});

// ─── AG-10: adapter error → anchor record REMAINS present (recoverable) ──────────
await withStore('ag10', () => {
  const b = fakeBroker({ submitFn: throwsClass(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK) });
  return submit(req('cid_ag10'), { broker: b }).then(() => {
    const s = get('cid_ag10');
    check('AG-10',
      s !== null && typeof s.anchor_persisted_at === 'string' && s.attempt_count === 1
      && s.events.some(e => e.type === 'broker_submit_anchor_persisted'),
      'after adapter failure the pending_submit anchor record persists (recoverable)');
  });
});

// ─── AG-11: local validation failure → NO submit, NO store write, throws ─────────
await withStore('ag11', async () => {
  const b = fakeBroker();
  const threwQty   = await threwAsync(() => submit(req('cid_ag11', { qty: 0 }), { broker: b }));
  const threwSym   = await threwAsync(() => submit(req('cid_ag11b', { symbol: '' }), { broker: b }));
  const threwAct   = await threwAsync(() => submit(req('cid_ag11c', { order_action: 'long' }), { broker: b }));
  check('AG-11',
    threwQty && threwSym && threwAct && b.calls.submitOrder === 0 && listAll().length === 0,
    'local validation (qty<=0 / empty symbol / bad order_action) → throw, no POST, nothing persisted');
});

// ─── AG-12: missing ctx.broker → throws, nothing persisted ───────────────────────
await withStore('ag12', async () => {
  const threw = await threwAsync(() => submit(req('cid_ag12'), {}));
  check('AG-12', threw && listAll().length === 0, 'missing ctx.broker → throws before any store write');
});

// ─── AG-13: idempotent re-entry on success → no-op, single submit ────────────────
await withStore('ag13', async () => {
  const b = fakeBroker();
  const r1 = await submit(req('cid_ag13'), { broker: b });
  const r2 = await submit(req('cid_ag13'), { broker: b });
  check('AG-13',
    r1.state === 'submitted' && r2.state === 'submitted' && r2.broker_order_id === r1.broker_order_id
    && b.calls.submitOrder === 1 && listAll().length === 1,
    'second submit() for same cid is a no-op (returns stored record), exactly 1 POST, single record');
});

// ─── AG-14: deterministic cid generated + persisted when none supplied ───────────
await withStore('ag14', () => {
  const b = fakeBroker();
  const r = { symbol: 'AMAT', qty: 2, side: 'long', order_action: 'buy', run_id: 'run_2026-06-16_0824' };
  return submit(r, { broker: b }).then(rec => {
    const expected = 'cid_v1_run_2026-06-16_0824_AMAT_long_buy';
    check('AG-14',
      rec.client_order_id === expected && get(expected) !== null && rec.state === 'submitted',
      'no explicit cid → deterministic cid_v1_{run}_{symbol}_{side}_{action} built + persisted');
  });
});

// ─── AG-15: unbuildable cid (no run_id, no explicit cid) → throws, no submit ─────
await withStore('ag15', async () => {
  const b = fakeBroker();
  const threw = await threwAsync(() => submit({ symbol: 'AMAT', qty: 2, side: 'long', order_action: 'buy' }, { broker: b }));
  check('AG-15', threw && b.calls.submitOrder === 0 && listAll().length === 0,
    'no explicit cid and no run_id → cannot build deterministic cid → throws, no POST');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\norder_gateway_step4_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
