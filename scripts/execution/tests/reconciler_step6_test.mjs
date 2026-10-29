#!/usr/bin/env node
/**
 * Reconciler — Phase 1 / Unit 6 recovery/reconciliation tests (RC-01 … RC-16).
 *
 * Isolated: every case uses a temp OrderStore dir via _setOrderStorePaths and a
 * fake INJECTED broker that exposes ONLY getOrderByClientId (proving NO resubmit:
 * the reconciler never reaches for submitOrder). Fully offline, no network.
 *
 * node scripts/execution/tests/reconciler_step6_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { readFileSync, mkdirSync } from 'fs';
import { join }                    from 'path';
import { tmpdir }                  from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import {
  upsert, get,
  _setOrderStorePaths, _clearOrderStorePaths,
} from '../live_broker/order_store.mjs';
import { reconcileOnce } from '../live_broker/reconciler.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `reconciler_${process.pid}`);
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

function seed(cid, over = {}) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: 'AMAT', side: 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_x', action: 'open', order_action: 'buy', qty: 10 },
  );
  upsert({ ...r, ...over });
  return get(cid);
}

// Fake broker: ONLY getOrderByClientId — NO submitOrder (proves the reconciler never resubmits).
function fakeBroker(viewOrFn) {
  const calls = { getOrderByClientId: 0 };
  return {
    calls,
    async getOrderByClientId(cid) {
      calls.getOrderByClientId += 1;
      const v = typeof viewOrFn === 'function' ? viewOrFn(cid) : viewOrFn;
      return v === undefined ? null : v;
    },
  };
}
const view = (status, over = {}) => ({ provider: 'alpaca', broker_order_id: 'B', broker_status: status, filled_qty: 0, avg_fill_price: null, ...over });

// ─── RC-01: submit_unknown + broker hit → adopted to legal submitted ─────────────
await withStore('rc01', async () => {
  seed('cid_su', { state: 'submit_unknown', broker_order_id: null });
  const s = await reconcileOnce({ broker: fakeBroker(view('new', { broker_order_id: 'B_found' })) });
  const r = get('cid_su');
  check('RC-01',
    r.state === 'submitted' && r.broker_order_id === 'B_found' && r.reconcile_flag === null
    && s.adopted === 1 && s.resolved === 1,
    'submit_unknown + new → adopted to legal submitted, broker_order_id captured, flag cleared');
});

// ─── RC-02: submit_unknown + not found → fail-closed, NO resubmit ────────────────
await withStore('rc02', async () => {
  seed('cid_sunf', { state: 'submit_unknown' });
  const b = fakeBroker(() => null);
  const s = await reconcileOnce({ broker: b });
  const r = get('cid_sunf');
  check('RC-02',
    r.state === 'submit_unknown' && r.reconcile_flag === 'unresolved_not_found'
    && s.not_found === 1 && s.escalated === 1 && b.calls.getOrderByClientId === 1,
    'submit_unknown + not found → unresolved_not_found, state kept, no resubmit (broker has no submitOrder)');
});

// ─── RC-03: pending_submit + broker hit → adopted to submitted ───────────────────
await withStore('rc03', async () => {
  seed('cid_ps', { state: 'pending_submit', broker_order_id: null });
  await reconcileOnce({ broker: fakeBroker(view('new', { broker_order_id: 'B_ps' })) });
  const r = get('cid_ps');
  check('RC-03', r.state === 'submitted' && r.broker_order_id === 'B_ps' && r.reconcile_flag === null,
    'pending_submit + new → adopted to submitted (poller takes over)');
});

// ─── RC-04: pending_submit + not found → fail-closed, NO resubmit ────────────────
await withStore('rc04', async () => {
  seed('cid_psnf', { state: 'pending_submit' });
  const s = await reconcileOnce({ broker: fakeBroker(() => null) });
  const r = get('cid_psnf');
  check('RC-04',
    r.state === 'pending_submit' && r.reconcile_flag === 'unresolved_not_found' && s.escalated === 1,
    'pending_submit + not found → unresolved_not_found, state kept, no resubmit');
});

// ─── RC-05: reconcile_flag=broker_not_found + reappears → resolved (flag cleared) ─
await withStore('rc05', async () => {
  seed('cid_bnf', { state: 'acknowledged', reconcile_flag: 'broker_not_found' });
  const s = await reconcileOnce({ broker: fakeBroker(view('new')) });   // new → acknowledged == current state
  const r = get('cid_bnf');
  check('RC-05',
    r.reconcile_flag === null && r.state === 'acknowledged' && s.resolved === 1,
    'broker_not_found + order reappears consistent → flag cleared, state unchanged');
});

// ─── RC-06: reconcile_flag=unknown_broker_status still unknown → kept fail-closed ─
await withStore('rc06', async () => {
  seed('cid_unk', { state: 'acknowledged', reconcile_flag: 'unknown_broker_status' });
  const s = await reconcileOnce({ broker: fakeBroker(view('held')) });   // still unmappable
  const r = get('cid_unk');
  check('RC-06',
    r.reconcile_flag === 'unknown_broker_status' && s.escalated === 1,
    'unknown_broker_status still unmappable → flag kept, escalated (no guess)');
});

// ─── RC-07: illegal_status_transition not silently overwritten ───────────────────
await withStore('rc07', async () => {
  // partially_filled flagged; broker says 'new' (→acknowledged) which is ILLEGAL from partially_filled
  seed('cid_ill', { state: 'partially_filled', filled_qty: 4, remaining_qty: 6, last_applied_filled_qty: 4, reconcile_flag: 'illegal_status_transition:partially_filled->acknowledged' });
  const s = await reconcileOnce({ broker: fakeBroker(view('new', { filled_qty: 4 })) });
  const r = get('cid_ill');
  check('RC-07',
    r.state === 'partially_filled' && String(r.reconcile_flag).startsWith('illegal_status_transition') && s.escalated === 1,
    'illegal target still illegal → flag kept, no silent overwrite');
  // and a RESOLVABLE variant: broker now 'filled' (legal forward partially_filled→filled) → flag cleared
  await reconcileOnce({ broker: fakeBroker(view('filled', { filled_qty: 10 })) });
  check('RC-07b', get('cid_ill').reconcile_flag === null && get('cid_ill').state === 'partially_filled',
    'illegal flag clears when broker truth is a legal forward (filled); state left to poller');
});

// ─── RC-08: filled_qty_regression is never "corrected away" ──────────────────────
await withStore('rc08', async () => {
  seed('cid_reg', { state: 'partially_filled', filled_qty: 7, remaining_qty: 3, last_applied_filled_qty: 7, reconcile_flag: 'filled_qty_regression' });
  // broker still reports LESS than applied → must stay flagged, filled_qty unchanged
  const s = await reconcileOnce({ broker: fakeBroker(view('partially_filled', { filled_qty: 5 })) });
  const r = get('cid_reg');
  const keptFlagged = r.reconcile_flag === 'filled_qty_regression' && r.filled_qty === 7 && s.escalated === 1;
  // broker caught up (>= applied) → flag clears, but filled_qty STILL not rolled by reconciler
  await reconcileOnce({ broker: fakeBroker(view('partially_filled', { filled_qty: 9 })) });
  const r2 = get('cid_reg');
  check('RC-08',
    keptFlagged && r2.reconcile_flag === null && r2.filled_qty === 7,
    'regression: stays flagged while broker<applied; clears when broker>=applied; filled_qty never rolled back/forward');
});

// ─── RC-09: append-only events written in sensible order ─────────────────────────
await withStore('rc09', async (d) => {
  seed('cid_ev', { state: 'submit_unknown' });
  await reconcileOnce({ broker: fakeBroker(view('new', { broker_order_id: 'B1' })) });
  const ev = events(d).map(e => e.type);
  check('RC-09',
    ev[0] === 'broker_reconcile_started' && ev.includes('broker_reconcile_adopted')
    && events(d).every(e => e.client_order_id === 'cid_ev' && typeof e.ts === 'string'),
    'append-only: started then adopted; client_order_id + ts on every line');
});

// ─── RC-10: summary counters across a mixed batch ────────────────────────────────
await withStore('rc10', async () => {
  seed('cid_a', { state: 'submit_unknown' });                                    // → adopted
  seed('cid_b', { state: 'pending_submit' });                                    // → not_found/escalated
  seed('cid_c', { state: 'acknowledged', reconcile_flag: 'broker_not_found' });  // → resolved
  seed('cid_d', { state: 'submitted' });                                         // clean, NOT a candidate
  const b = fakeBroker((cid) => (cid === 'cid_b' ? null : view('new')));
  const s = await reconcileOnce({ broker: b });
  check('RC-10',
    s.scanned === 3 && s.adopted === 1 && s.resolved === 2 && s.not_found === 1 && s.escalated === 1
    && b.calls.getOrderByClientId === 3,
    'mixed batch: clean submitted skipped; 3 candidates scanned; counters consistent');
});

// ─── RC-11: pending_submit + broker terminal that is ILLEGAL from anchor → held ──
await withStore('rc11', async () => {
  // pending_submit legal = [submitted, submit_unknown, rejected]; 'canceled' → cancelled is NOT legal
  seed('cid_canc', { state: 'pending_submit' });
  const s = await reconcileOnce({ broker: fakeBroker(view('canceled')) });
  const r = get('cid_canc');
  check('RC-11',
    r.state === 'pending_submit' && r.reconcile_flag === 'no_legal_target' && s.escalated === 1,
    'pending_submit + canceled (illegal edge) → no_legal_target, held fail-closed (contract not bent)');
});

// ─── RC-12: pending_submit + broker filled → adopted to submitted (no fill stranding) ─
await withStore('rc12', async () => {
  seed('cid_fil', { state: 'pending_submit' });
  await reconcileOnce({ broker: fakeBroker(view('filled', { filled_qty: 10, avg_fill_price: 100 })) });
  const r = get('cid_fil');
  check('RC-12',
    r.state === 'submitted' && r.terminal_at == null && r.filled_qty === 0,
    'pending_submit + filled → adopted to submitted (NOT filled); fills left to the poller');
});

// ─── RC-13: reconcile_hold + broker hit → adopted to submitted ───────────────────
await withStore('rc13', async () => {
  seed('cid_hold', { state: 'reconcile_hold' });
  await reconcileOnce({ broker: fakeBroker(view('new', { broker_order_id: 'B_h' })) });
  const r = get('cid_hold');
  check('RC-13', r.state === 'submitted' && r.broker_order_id === 'B_h' && r.reconcile_flag === null,
    'reconcile_hold + new → adopted to submitted (re-entered live lane)');
});

// ─── RC-14: adapter error → record NOT mutated, errored counted ──────────────────
await withStore('rc14', async () => {
  seed('cid_err', { state: 'submit_unknown' });
  const before = JSON.stringify(get('cid_err'));
  const b = { async getOrderByClientId() { throw new Error('network down'); } };
  const s = await reconcileOnce({ broker: b });
  check('RC-14', s.errored === 1 && JSON.stringify(get('cid_err')) === before,
    'broker error → record unchanged (not corrupted), errored counted');
});

// ─── RC-15: clean record (no flag, pollable state) is NOT a candidate ────────────
await withStore('rc15', async () => {
  seed('cid_clean', { state: 'acknowledged' });
  const b = fakeBroker(view('new'));
  const s = await reconcileOnce({ broker: b });
  check('RC-15', s.scanned === 0 && b.calls.getOrderByClientId === 0,
    'clean acknowledged (no reconcile_flag) is left to the FillPoller, not scanned');
});

// ─── RC-16: missing ctx.broker → throws ──────────────────────────────────────────
await withStore('rc16', async () => {
  check('RC-16', await threwAsync(() => reconcileOnce({})), 'missing ctx.broker → throws');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nreconciler_step6_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
