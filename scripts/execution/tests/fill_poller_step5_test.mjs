#!/usr/bin/env node
/**
 * FillPoller — Phase 1 / Unit 5 tests (FP-01 … FP-16).
 *
 * Isolated: every case uses a temp OrderStore dir via _setOrderStorePaths and a
 * fake INJECTED broker (ctx.broker). No live store, NO real broker IO, no network.
 *
 * node scripts/execution/tests/fill_poller_step5_test.mjs
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
import { pollOnce, mapBrokerStatus } from '../live_broker/fill_poller.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `fillpoller_${process.pid}`);
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

// Seed a broker order record in a given state (a submitted/active order).
function seed(cid, over = {}) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: 'AMAT', side: 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_x', action: 'open', order_action: 'buy', qty: 10 },
  );
  upsert({ ...r, state: 'submitted', broker_order_id: 'B_' + cid, ...over });
  return get(cid);
}

// Fake broker: returns a programmed view (or per-cid function), records call count.
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

// ─── FP-00: mapBrokerStatus is conservative (unknown → null) ─────────────────────
{
  check('FP-00',
    mapBrokerStatus('new') === 'acknowledged' && mapBrokerStatus('filled') === 'filled'
    && mapBrokerStatus('canceled') === 'cancelled' && mapBrokerStatus('done_for_day') === 'expired'
    && mapBrokerStatus('held') === null && mapBrokerStatus('weird_new_status') === null && mapBrokerStatus(undefined) === null,
    'mapBrokerStatus maps known statuses, returns null for held/unknown/non-string');
}

// ─── FP-01: listNonTerminal records are read and each is polled ──────────────────
await withStore('fp01', async () => {
  seed('cid_a'); seed('cid_b'); seed('cid_c', { state: 'filled' });   // filled = terminal, not polled
  const b = fakeBroker(view('new'));
  const s = await pollOnce({ broker: b });
  check('FP-01', s.scanned === 2 && b.calls.getOrderByClientId === 2,
    'only the 2 non-terminal records are scanned & polled (filled excluded by store)');
});

// ─── FP-02: submitted + broker `new` → acknowledged ──────────────────────────────
await withStore('fp02', async () => {
  seed('cid_ack');
  await pollOnce({ broker: fakeBroker(view('new')) });
  check('FP-02', get('cid_ack').state === 'acknowledged' && get('cid_ack').broker_status === 'new',
    'submitted + new → acknowledged, raw broker_status persisted');
});

// ─── FP-03: acknowledged + partially_filled → partially_filled, fill delta applied ─
await withStore('fp03', async () => {
  seed('cid_pf', { state: 'acknowledged' });
  await pollOnce({ broker: fakeBroker(view('partially_filled', { filled_qty: 4, avg_fill_price: 100 })) });
  const r = get('cid_pf');
  check('FP-03',
    r.state === 'partially_filled' && r.filled_qty === 4 && r.remaining_qty === 6
    && r.last_applied_filled_qty === 4 && r.avg_fill_price === 100 && r.fills.length === 1,
    'acknowledged + partially_filled → state + fill delta (4), remaining 6, avg 100');
});

// ─── FP-04: more fills → delta applied exactly once (cumulative) ─────────────────
await withStore('fp04', async () => {
  seed('cid_more', { state: 'partially_filled', filled_qty: 4, remaining_qty: 6, last_applied_filled_qty: 4, avg_fill_price: 100, fills: [{ delta_qty: 4, cumulative_qty: 4 }] });
  await pollOnce({ broker: fakeBroker(view('partially_filled', { filled_qty: 7, avg_fill_price: 101 })) });
  const r = get('cid_more');
  check('FP-04',
    r.filled_qty === 7 && r.last_applied_filled_qty === 7 && r.remaining_qty === 3
    && r.fills.length === 2 && Math.abs(r.fills[1].delta_qty - 3) < 1e-9,
    'cumulative 4→7 applies delta 3 once (fills grows to 2, remaining 3)');
});

// ─── FP-05: repeated poll with same filled_qty → no-op, no double-count, no write ─
await withStore('fp05', async (d) => {
  seed('cid_noop', { state: 'partially_filled', filled_qty: 4, remaining_qty: 6, last_applied_filled_qty: 4, avg_fill_price: 100, fills: [{ delta_qty: 4, cumulative_qty: 4 }] });
  await pollOnce({ broker: fakeBroker(view('partially_filled', { filled_qty: 4, avg_fill_price: 100 })) });
  const r = get('cid_noop');
  const ev = events(d).map(e => e.type);
  check('FP-05',
    r.filled_qty === 4 && r.fills.length === 1 && r.last_poll_at == null && ev.includes('broker_poll_no_change'),
    'same filled_qty → no double count, no record write (last_poll_at stays null), no_change event');
});

// ─── FP-06: partially_filled + filled → terminal, terminal_at set ────────────────
await withStore('fp06', async () => {
  seed('cid_fill', { state: 'partially_filled', filled_qty: 7, remaining_qty: 3, last_applied_filled_qty: 7, fills: [{ delta_qty: 7, cumulative_qty: 7 }] });
  await pollOnce({ broker: fakeBroker(view('filled', { filled_qty: 10, avg_fill_price: 102 })) });
  const r = get('cid_fill');
  check('FP-06',
    r.state === 'filled' && r.filled_qty === 10 && r.remaining_qty === 0
    && typeof r.terminal_at === 'string' && r.fills.length === 2,
    'partially_filled + filled → filled, remaining 0, terminal_at set, final delta applied');
});

// ─── FP-07: submit_unknown + broker hit (new) → adopted to legal `submitted` ─────
await withStore('fp07', async () => {
  seed('cid_su', { state: 'submit_unknown', broker_order_id: null });
  await pollOnce({ broker: fakeBroker(view('new', { broker_order_id: 'B_found' })) });
  const r = get('cid_su');
  check('FP-07',
    r.state === 'submitted' && r.broker_order_id === 'B_found',
    'submit_unknown + new → adopted to legal submitted (not acknowledged), broker_order_id captured');
});

// ─── FP-07b: submit_unknown + broker filled → adopted directly to filled (legal) ─
await withStore('fp07b', async () => {
  seed('cid_suf', { state: 'submit_unknown' });
  await pollOnce({ broker: fakeBroker(view('filled', { filled_qty: 10, avg_fill_price: 99 })) });
  const r = get('cid_suf');
  check('FP-07b', r.state === 'filled' && r.filled_qty === 10 && typeof r.terminal_at === 'string',
    'submit_unknown + filled → adopted directly to filled (legal edge), fill applied');
});

// ─── FP-08: broker null / not found → conservative flag, no state change ─────────
await withStore('fp08', async (d) => {
  seed('cid_nf', { state: 'acknowledged' });
  const s = await pollOnce({ broker: fakeBroker(() => null) });
  const r = get('cid_nf');
  check('FP-08',
    r.state === 'acknowledged' && r.reconcile_flag === 'broker_not_found' && s.not_found === 1
    && events(d).some(e => e.type === 'broker_poll_not_found'),
    'not found → state unchanged, reconcile_flag=broker_not_found, not hallucinated as cancelled');
});

// ─── FP-09: unknown broker status → NOT optimistically mapped, fail-closed flag ──
await withStore('fp09', async () => {
  seed('cid_unk', { state: 'acknowledged' });
  const s = await pollOnce({ broker: fakeBroker(view('held')) });
  const r = get('cid_unk');
  check('FP-09',
    r.state === 'acknowledged' && r.reconcile_flag === 'unknown_broker_status' && s.inconsistent === 1,
    'unknown status (held) → no state change, reconcile_flag=unknown_broker_status');
});

// ─── FP-10: filled_qty regression → fail-closed, no roll-back ────────────────────
await withStore('fp10', async () => {
  seed('cid_reg', { state: 'partially_filled', filled_qty: 7, remaining_qty: 3, last_applied_filled_qty: 7 });
  const s = await pollOnce({ broker: fakeBroker(view('partially_filled', { filled_qty: 5 })) });   // 5 < 7
  const r = get('cid_reg');
  check('FP-10',
    r.filled_qty === 7 && r.last_applied_filled_qty === 7 && r.reconcile_flag === 'filled_qty_regression' && s.inconsistent === 1,
    'broker filled_qty 5 < applied 7 → fail-closed, no roll-back, regression flagged');
});

// ─── FP-11: event log append-only + sensible order (advance + fill) ──────────────
await withStore('fp11', async (d) => {
  seed('cid_ev', { state: 'acknowledged' });
  await pollOnce({ broker: fakeBroker(view('partially_filled', { filled_qty: 2, avg_fill_price: 50 })) });
  const ev = events(d);
  check('FP-11',
    ev.map(e => e.type).join(',') === 'broker_status_advanced,broker_fill_delta_applied'
    && ev.every(e => e.client_order_id === 'cid_ev' && typeof e.ts === 'string'),
    'append-only: status_advanced then fill_delta_applied; client_order_id + ts on every line');
});

// ─── FP-12: illegal target transition → fail-closed, no state change ─────────────
await withStore('fp12', async () => {
  seed('cid_ill', { state: 'partially_filled', filled_qty: 4, remaining_qty: 6, last_applied_filled_qty: 4 });
  // broker 'new' → acknowledged, but partially_filled → acknowledged is NOT legal.
  // filled_qty matches applied (4) so delta=0 isolates the transition-legality check.
  const s = await pollOnce({ broker: fakeBroker(view('new', { filled_qty: 4 })) });
  const r = get('cid_ill');
  check('FP-12',
    r.state === 'partially_filled' && String(r.reconcile_flag).startsWith('illegal_status_transition') && s.inconsistent === 1,
    'illegal edge (partially_filled→acknowledged) → no state change, flagged');
});

// ─── FP-13: execution_id dedupe — same exec id never double-applies ──────────────
await withStore('fp13', async () => {
  seed('cid_exec', { state: 'acknowledged' });
  const b = fakeBroker(view('partially_filled', { filled_qty: 3, avg_fill_price: 70, execution_id: 'EX1' }));
  await pollOnce({ broker: b });                          // applies delta 3, records EX1
  // Same exec id re-delivered with same cumulative → must NOT double-apply
  await pollOnce({ broker: fakeBroker(view('partially_filled', { filled_qty: 3, avg_fill_price: 70, execution_id: 'EX1' })) });
  const r = get('cid_exec');
  check('FP-13', r.filled_qty === 3 && r.fills.length === 1 && r.fills[0].execution_id === 'EX1',
    'execution_id dedupe: same EX1 cumulative re-delivery is a no-op (single fill)');
});

// ─── FP-14: cumulative-only fallback (no execution_id) works across two polls ────
await withStore('fp14', async () => {
  seed('cid_cum', { state: 'acknowledged' });
  await pollOnce({ broker: fakeBroker(view('partially_filled', { filled_qty: 2, avg_fill_price: 10 })) });
  await pollOnce({ broker: fakeBroker(view('partially_filled', { filled_qty: 5, avg_fill_price: 11 })) });
  const r = get('cid_cum');
  check('FP-14', r.filled_qty === 5 && r.fills.length === 2 && Math.abs(r.fills[1].delta_qty - 3) < 1e-9,
    'no execution_id → monotone cumulative delta (2 then +3) drives two fills');
});

// ─── FP-15: reconcile_hold held (no broker call); pending_submit skipped ─────────
await withStore('fp15', async () => {
  seed('cid_hold', { state: 'reconcile_hold' });
  seed('cid_pend', { state: 'pending_submit' });
  const b = fakeBroker(view('filled', { filled_qty: 10 }));
  const s = await pollOnce({ broker: b });
  check('FP-15',
    s.held === 1 && s.skipped === 1 && b.calls.getOrderByClientId === 0
    && get('cid_hold').state === 'reconcile_hold' && get('cid_pend').state === 'pending_submit',
    'reconcile_hold=held, pending_submit=skipped, no broker call, no mutation');
});

// ─── FP-16: adapter/network error → record NOT mutated, errored counted ──────────
await withStore('fp16', async () => {
  seed('cid_err', { state: 'acknowledged' });
  const before = JSON.stringify(get('cid_err'));
  const b = { async getOrderByClientId() { throw new Error('network down'); } };
  const s = await pollOnce({ broker: b });
  check('FP-16',
    s.errored === 1 && JSON.stringify(get('cid_err')) === before,
    'broker error → record unchanged (not corrupted), errored counted');
});

// ─── FP-17: missing ctx.broker → throws ──────────────────────────────────────────
await withStore('fp17', async () => {
  check('FP-17', await threwAsync(() => pollOnce({})), 'missing ctx.broker → throws');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nfill_poller_step5_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
