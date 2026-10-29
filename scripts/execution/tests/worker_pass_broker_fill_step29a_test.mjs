#!/usr/bin/env node
/**
 * WorkerPass + BrokerFillBooking — Unit 29a integration tests (BB-01 … BB-07).
 *
 * Verifies that bookBrokerFills is correctly wired into runWorkerPassOnce as an
 * opt-in step (ctx.bookFills=true) that runs after syncFillsToPortfolio, sharing
 * the booked_fills watermark without double-booking.
 *
 * Tests:
 *   BB-01  bookFills not set  → steps.booking stays null (disabled by default)
 *   BB-02  bookFills=true, no eligible records  → booking ran, eligible=0
 *   BB-03  bookFills=true, FILLED record  → sync books it; booking sees already_booked
 *   BB-04  bookFills=true, PARTIALLY_FILLED record  → sync skips; booking books it
 *   BB-05  bookFills=true, gate unsafe  → steps.booking skipped(gate_unsafe)
 *   BB-06  bookFills=true, cycle did not run (held lease)  → booking skipped(cycle_did_not_run)
 *   BB-07  bookFills=true, second pass  → booking fully idempotent (already_booked)
 *
 * node scripts/execution/tests/worker_pass_broker_fill_step29a_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { makeBrokerOrderRecord, ORDER_STATES } from '../schemas.mjs';
import { upsert, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { acquireLease, _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { initPortfolio, loadOrInit, _setTestPaths, _clearTestPaths } from '../portfolio/portfolio_state.mjs';
import { runWorkerPassOnce } from '../live_broker/worker_pass.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const ROOT = join(tmpdir(), `wp_booking_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
mkdirSync(ROOT, { recursive: true });

const PAPER_CFG = Object.freeze({ enabled: true, mode: 'alpaca_paper', paper: true, base_url: 'https://paper-api.alpaca.markets', key_id: 'k', secret_key: 's' });

async function withEnv(tag, fn) {
  const d        = join(ROOT, tag);
  const ordersDir = join(d, 'orders');
  const pfDir     = join(d, 'portfolio');
  mkdirSync(ordersDir, { recursive: true });
  mkdirSync(pfDir,     { recursive: true });
  const leaseP    = join(ordersDir, '.paper_runner.lease');
  const statePath = join(pfDir, 'state.json');
  writeFileSync(statePath, JSON.stringify(initPortfolio(), null, 2) + '\n', 'utf8');
  const portfolioPaths = { state: statePath, history: join(pfDir, 'hist.jsonl'), ledger: join(pfDir, 'ledger.jsonl') };
  const apply = () => {
    _setOrderStorePaths({ dir: ordersDir, eventsLog: join(ordersDir, 'events.jsonl') });
    _setLeasePath(leaseP);
    _setTestPaths(portfolioPaths);
  };
  apply();
  const reloadState = () => { apply(); return loadOrInit(); };
  try { return await fn({ dir: d, leaseP, reloadState }); }
  finally { _clearOrderStorePaths(); _clearLeasePath(); _clearTestPaths(); }
}

function fakeBroker({ lookupFn } = {}) {
  const calls = { submitOrder: 0, getOrderByClientId: 0 };
  return {
    calls,
    async submitOrder(r) {
      calls.submitOrder += 1;
      return { provider: 'alpaca', client_order_id: r.client_order_id, broker_order_id: 'B_' + r.client_order_id, broker_status: 'accepted' };
    },
    async getOrderByClientId(cid) {
      calls.getOrderByClientId += 1;
      if (typeof lookupFn === 'function') return lookupFn(cid);
      return { provider: 'alpaca', broker_order_id: 'B_' + cid, broker_status: 'accepted', filled_qty: 0, avg_fill_price: null };
    },
  };
}

function makeRecord(cid, overrides = {}) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: overrides.symbol ?? 'AMAT', side: overrides.side ?? 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_prev', action: 'open', order_action: 'buy', qty: overrides.qty ?? 2 },
  );
  return { ...r, ...overrides };
}

function filledRecord(cid, { symbol = 'AMAT', side = 'long', qty = 2, px = 108 } = {}) {
  return makeRecord(cid, {
    symbol, side, qty,
    state: ORDER_STATES.FILLED,
    filled_qty: qty, remaining_qty: 0, avg_fill_price: px,
    last_applied_filled_qty: qty, terminal_at: '2026-07-27T08:00:00.000Z',
  });
}

function partiallyFilledRecord(cid, { symbol = 'ASTS', side = 'long', filledQty = 1, totalQty = 3, px = 56 } = {}) {
  return makeRecord(cid, {
    symbol, side, qty: totalQty,
    state: ORDER_STATES.PARTIALLY_FILLED,
    filled_qty: filledQty, remaining_qty: totalQty - filledQty, avg_fill_price: px,
    last_applied_filled_qty: filledQty,
  });
}

// ── BB-01: bookFills not set → steps.booking stays null ──────────────────────
await withEnv('bb01', async () => {
  const s = await runWorkerPassOnce({ broker: fakeBroker(), execConfig: PAPER_CFG });
  check('BB-01', s.steps.booking === null,
    'bookFills not set → steps.booking is null (feature disabled by default)');
});

// ── BB-02: bookFills=true, empty store → booking ran, eligible=0 ─────────────
await withEnv('bb02', async () => {
  const s = await runWorkerPassOnce({ broker: fakeBroker(), execConfig: PAPER_CFG, bookFills: true });
  check('BB-02',
    s.steps.booking != null && s.steps.booking.skipped !== true &&
    s.steps.booking.eligible === 0 && s.steps.booking.booked_open === 0,
    'bookFills=true, empty store → booking ran, eligible=0, nothing booked');
});

// ── BB-03: FILLED record → sync books (booked_open:1); booking sees already_booked ─
await withEnv('bb03', async ({ reloadState }) => {
  upsert(filledRecord('cid_bb03', { symbol: 'AMAT', side: 'long', qty: 2, px: 108 }));
  const s = await runWorkerPassOnce({ broker: fakeBroker(), execConfig: PAPER_CFG, run_id: 'run_bb03', bookFills: true });
  const st = reloadState();
  check('BB-03',
    s.steps.sync.booked_open === 1 &&
    s.steps.booking.already_booked === 1 &&
    s.steps.booking.booked_open === 0 &&
    st.open_positions.length === 1 &&
    st.booked_fills['cid_bb03'] === 2,
    'FILLED record: sync books it (booked_open:1), booking sees already_booked:1 — shared watermark prevents double-booking');
});

// ── BB-04: PARTIALLY_FILLED record → sync skips; booking books it ─────────────
await withEnv('bb04', async ({ reloadState }) => {
  upsert(partiallyFilledRecord('cid_bb04', { symbol: 'ASTS', side: 'long', filledQty: 1, totalQty: 3, px: 56 }));
  const s = await runWorkerPassOnce({ broker: fakeBroker(), execConfig: PAPER_CFG, run_id: 'run_bb04', bookFills: true });
  const st = reloadState();
  const pos = st.open_positions.find(p => p.symbol === 'ASTS' && p.side === 'long');
  check('BB-04',
    s.steps.sync.eligible === 0 &&           // fill_sync skips PARTIALLY_FILLED
    s.steps.booking.booked_open === 1 &&      // bookBrokerFills picks it up
    pos != null && pos.quantity === 1 &&
    st.booked_fills['cid_bb04'] === 1,
    'PARTIALLY_FILLED: fill_sync skips (eligible=0), bookBrokerFills books it (booked_open:1)');
});

// ── BB-05: gate unsafe → steps.booking skipped(gate_unsafe) ──────────────────
await withEnv('bb05', async () => {
  // seed a blocking submit_unknown record
  const rec = makeRecord('cid_su_bb05', {
    state: 'submit_unknown', filled_qty: 0, avg_fill_price: null,
  });
  upsert(rec);
  const s = await runWorkerPassOnce({
    broker: fakeBroker({ lookupFn: () => null }),
    execConfig: PAPER_CFG,
    bookFills: true,
  });
  check('BB-05',
    s.reason === 'gate_unsafe' &&
    s.steps.booking != null &&
    s.steps.booking.skipped === true &&
    s.steps.booking.reason === 'gate_unsafe',
    'gate unsafe + bookFills=true → steps.booking.skipped(gate_unsafe)');
});

// ── BB-06: gate unsafe (held lease) → booking skipped(gate_unsafe) ───────────
// Held lease blocks assertStartupGate → gate_unsafe. Distinct from BB-05 (submit_unknown blocker).
await withEnv('bb06', async () => {
  acquireLease({});
  const s = await runWorkerPassOnce({ broker: fakeBroker(), execConfig: PAPER_CFG, bookFills: true });
  check('BB-06',
    s.reason === 'gate_unsafe' &&
    s.steps.booking != null &&
    s.steps.booking.skipped === true &&
    s.steps.booking.reason === 'gate_unsafe',
    'held lease + bookFills=true → booking skipped(gate_unsafe) via lease contention');
});

// ── BB-07: second pass → booking idempotent (already_booked) ─────────────────
// Uses stable broker lookupFn returning consistent partially_filled response to prevent
// FillPoller from flagging filled_qty_regression (which would make second gate unsafe).
await withEnv('bb07', async ({ reloadState }) => {
  upsert(partiallyFilledRecord('cid_bb07', { symbol: 'KAITO', side: 'long', filledQty: 2, totalQty: 5, px: 1.18 }));
  const b = fakeBroker({ lookupFn: (cid) => ({
    provider: 'alpaca', broker_order_id: 'B_' + cid,
    broker_status: 'partially_filled', filled_qty: 2, avg_fill_price: 1.18,
  }) });
  const s1 = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, run_id: 'r1', bookFills: true });
  const s2 = await runWorkerPassOnce({ broker: b, execConfig: PAPER_CFG, run_id: 'r2', bookFills: true });
  const st = reloadState();
  check('BB-07',
    s1.steps.booking.booked_open === 1 &&
    s2.steps.booking.already_booked === 1 &&
    s2.steps.booking.booked_open === 0 &&
    st.open_positions.length === 1,
    'second pass: booking fully idempotent — already_booked:1, no duplicate position');
});

// ── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nWorkerPass+BrokerFillBooking (Unit 29a): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
