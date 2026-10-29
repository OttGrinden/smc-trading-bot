#!/usr/bin/env node
/**
 * BrokerFillBooking — Unit 28 tests (PB-01 … PB-10).
 *
 * Fully offline + deterministic. Each test gets its own temp dir for order records
 * and portfolio state — no production paths touched.
 *
 * Price convention (same as fill_sync test): USD = EUR × 1.08 so EUR values are exact.
 *   108 USD → 100 EUR ; 129.6 USD → 120 EUR ; 216 USD → 200 EUR
 *
 * node scripts/execution/tests/broker_fill_booking_step28_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { makeBrokerOrderRecord, ORDER_STATES } from '../schemas.mjs';
import { upsert, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import {
  initPortfolio, loadOrInit, _setTestPaths, _clearTestPaths,
} from '../portfolio/portfolio_state.mjs';
import { bookBrokerFills }      from '../live_broker/broker_fill_booking.mjs';
import { syncFillsToPortfolio } from '../live_broker/fill_sync.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

const ROOT = join(tmpdir(), `broker_fill_booking_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

/**
 * Isolated env per test: separate temp dirs for order store + portfolio paths.
 * Overrides are set before fn() and cleared in finally — not re-applied between passes.
 */
function withEnv(tag, initialState, fn) {
  const base     = join(ROOT, tag);
  const storeDir = join(base, 'orders');
  mkdirSync(storeDir, { recursive: true });
  const statePath = join(base, 'state.json');
  const paths = {
    state:   statePath,
    history: join(base, 'hist.jsonl'),
    ledger:  join(base, 'ledger.jsonl'),
  };
  writeFileSync(statePath, JSON.stringify(initialState, null, 2) + '\n', 'utf8');

  const apply = () => {
    _setOrderStorePaths({ dir: storeDir, eventsLog: join(storeDir, 'live_order_events.jsonl') });
    _setTestPaths(paths);
  };
  const reload = () => { apply(); return loadOrInit(); };

  apply();
  try { return fn({ statePath, reload }); }
  finally { _clearOrderStorePaths(); _clearTestPaths(); }
}

// ─── Record factories ─────────────────────────────────────────────────────────

/** Fully FILLED broker record. */
function filledRec(cid, { symbol = 'AAPL', side = 'long', action = 'open', qty = 2, px = 108 } = {}) {
  const orderAction = action === 'open'
    ? (side === 'long' ? 'buy' : 'sell_short')
    : (side === 'long' ? 'sell' : 'buy_to_cover');
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol, side, asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_pb', action, order_action: orderAction, qty },
  );
  return {
    ...r,
    state:                  'filled',
    filled_qty:             qty,
    remaining_qty:          0,
    avg_fill_price:         px,
    last_applied_filled_qty: qty,
    broker_order_id:        'b_' + cid,
    terminal_at:            '2026-07-22T08:00:00.000Z',
  };
}

/** PARTIALLY_FILLED broker record. totalQty is the order qty; filledQty is how much filled so far. */
function partialRec(cid, { symbol = 'AAPL', side = 'long', action = 'open', totalQty = 10, filledQty = 3, px = 108 } = {}) {
  const orderAction = action === 'open'
    ? (side === 'long' ? 'buy' : 'sell_short')
    : (side === 'long' ? 'sell' : 'buy_to_cover');
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol, side, asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_pb', action, order_action: orderAction, qty: totalQty },
  );
  return {
    ...r,
    state:                  'partially_filled',
    filled_qty:             filledQty,
    remaining_qty:          totalQty - filledQty,
    avg_fill_price:         px,
    last_applied_filled_qty: filledQty,
    broker_order_id:        'b_' + cid,
    terminal_at:            null,
  };
}

/** Open position as the portfolio would hold it (for pre-seeding close tests). */
function openPos({ symbol = 'AAPL', side = 'long', qty = 2, entryUsd = 108, cid = null } = {}) {
  const entryEur = +(entryUsd / 1.08).toFixed(6);
  return {
    symbol, asset_type: 'stock', side, quantity: qty,
    notional_eur:     +(qty * entryEur).toFixed(4),
    entry_price_usd:  entryUsd,
    entry_price_eur:  entryEur,
    mark_price_usd:   entryUsd,
    mark_price_eur:   entryEur,
    unrealized_pnl_eur: 0,
    stop_loss_pct:    8, leverage: 1,
    entry_timestamp:  '2026-07-22T07:00:00.000Z',
    entry_run_id:     'run_prev',
    strategy:         'broker_fill',
    order_id:         cid ?? ('open_' + symbol),
    booked_from:      'broker_fill',
    mark_source:      'broker_fill',
  };
}

// ─── PB-01: No confirmed fills → no booking ───────────────────────────────────
withEnv('pb01', initPortfolio(), ({ reload }) => {
  // Records in non-bookable states only (submitted, acknowledged) — no FILLED or PARTIALLY_FILLED
  const submittedRec  = { ...filledRec('pb01_sub'), state: ORDER_STATES.SUBMITTED,    filled_qty: 0 };
  const ackRec        = { ...filledRec('pb01_ack'), state: ORDER_STATES.ACKNOWLEDGED, filled_qty: 0 };
  upsert(submittedRec);
  upsert(ackRec);

  const sum = bookBrokerFills({ run_id: 'run_pb' });
  const s   = reload();
  check('PB-01',
    sum.scanned === 2 && sum.eligible === 0 &&
    sum.booked_open === 0 && sum.booked_open_delta === 0 && sum.booked_close === 0 &&
    s.open_positions.length === 0 && (s.booked_fills == null || Object.keys(s.booked_fills).length === 0),
    'submitted/acknowledged records → eligible=0, no booking, no position, no watermark');
});

// ─── PB-02: Single FILLED buy → position opened, cash reduced, watermark set ──
withEnv('pb02', initPortfolio(), ({ reload }) => {
  upsert(filledRec('pb02', { symbol: 'AAPL', side: 'long', action: 'open', qty: 2, px: 108 }));
  // 108 USD = 100 EUR (1.08 rate); qty=2; notional=200 EUR

  const sum = bookBrokerFills({ run_id: 'run_pb' });
  const s   = reload();
  const pos = s.open_positions.find(p => p.symbol === 'AAPL' && p.side === 'long');

  check('PB-02',
    sum.booked_open === 1 && sum.already_booked === 0 && sum.skipped === 0 &&
    s.open_positions.length === 1 &&
    pos != null &&
    near(pos.entry_price_eur, 100) &&
    near(pos.notional_eur, 200) &&
    near(s.cash, 2000 - 200) &&
    near(s.equity_nav, 2000) &&
    s.booked_fills['pb02'] === 2 &&
    pos.booked_from === 'broker_fill' &&
    !pos.partial_fill,
    'FILLED buy: position opened (100 EUR entry, notional 200), cash 1800, watermark=2, no partial_fill flag');
});

// ─── PB-03: Single FILLED sell against existing position → close + realized PnL
withEnv('pb03',
  (() => {
    const s = initPortfolio();
    // Entry at 100 EUR (108 USD); close at 120 EUR (129.6 USD) → realized = +1 * 2 * (120-100) = +40 EUR
    s.open_positions.push(openPos({ symbol: 'AAPL', side: 'long', qty: 2, entryUsd: 108, cid: 'pb03_open' }));
    return s;
  })(),
  ({ reload }) => {
    upsert(filledRec('pb03', { symbol: 'AAPL', side: 'long', action: 'close', qty: 2, px: 129.6 }));
    const sum = bookBrokerFills({ run_id: 'run_pb' });
    const s   = reload();
    check('PB-03',
      sum.booked_close === 1 &&
      s.open_positions.length === 0 &&
      near(s.realized_pnl, 40) &&
      s.closed_positions_summary.count === 1 &&
      s.closed_positions_summary.wins === 1 &&
      s.booked_fills['pb03'] === 2,
      'FILLED sell: position closed, realized +40 EUR, wins+1, watermark=2');
  }
);

// ─── PB-04: Partial-fill sequence → only deltas booked, VWAP entry updated ────
//
// Order: 10 shares of NVDA
//   Poll 1: PARTIALLY_FILLED filled_qty=3  avg=108   → book 3,  entry_eur=100
//   Poll 2: PARTIALLY_FILLED filled_qty=7  avg=118.8 → book 4 more, entry_eur=110 VWAP
//   Poll 3: FILLED            filled_qty=10 avg=127.8 → book 3 more, entry_eur=118.33 VWAP
//
//   118.8 USD = 110 EUR (7×110 = 770 total cost for 7 shares, VWAP=110)
//   127.8 USD = 118.333... EUR (10×118.333 ≈ 1183.3 total cost for 10 shares, VWAP≈118.33)
//
withEnv('pb04', initPortfolio(), ({ reload }) => {
  const CID = 'pb04';

  // Poll 1: 3/10 filled at 108 USD (100 EUR)
  upsert(partialRec(CID, { symbol: 'NVDA', totalQty: 10, filledQty: 3, px: 108 }));
  const sum1 = bookBrokerFills({ run_id: 'run_pb' });
  const s1   = reload();
  const pos1 = s1.open_positions.find(p => p.symbol === 'NVDA');
  check('PB-04a',
    sum1.booked_open === 1 && sum1.booked_open_delta === 0 &&
    pos1 != null &&
    near(pos1.quantity, 3) &&
    near(pos1.entry_price_eur, 100) &&
    near(pos1.notional_eur, 300) &&
    pos1.partial_fill === true &&
    s1.booked_fills[CID] === 3,
    'first partial fill (3/10): position opened at qty=3, entry=100 EUR, partial_fill=true, watermark=3');

  // Poll 2: 7/10 filled, VWAP is now 118.8 USD = 110 EUR
  upsert(partialRec(CID, { symbol: 'NVDA', totalQty: 10, filledQty: 7, px: 118.8 }));
  const sum2 = bookBrokerFills({ run_id: 'run_pb' });
  const s2   = reload();
  const pos2 = s2.open_positions.find(p => p.symbol === 'NVDA');
  check('PB-04b',
    sum2.booked_open === 0 && sum2.booked_open_delta === 1 && sum2.already_booked === 0 &&
    pos2 != null &&
    near(pos2.quantity, 7) &&
    near(pos2.entry_price_eur, 110) &&    // VWAP = 118.8/1.08 = 110
    near(pos2.notional_eur, 770) &&
    pos2.partial_fill === true &&
    s2.booked_fills[CID] === 7,
    'second partial fill delta (4 more → 7/10): qty=7, VWAP entry=110 EUR, partial_fill=true, watermark=7');

  // Poll 3: FILLED at 10/10, VWAP = 127.8 USD ≈ 118.33 EUR
  upsert(filledRec(CID, { symbol: 'NVDA', side: 'long', action: 'open', qty: 10, px: 127.8 }));
  const sum3 = bookBrokerFills({ run_id: 'run_pb' });
  const s3   = reload();
  const pos3 = s3.open_positions.find(p => p.symbol === 'NVDA');
  check('PB-04c',
    sum3.booked_open === 0 && sum3.booked_open_delta === 1 && sum3.already_booked === 0 &&
    pos3 != null &&
    near(pos3.quantity, 10) &&
    near(pos3.entry_price_eur, 127.8 / 1.08, 1e-3) &&   // final VWAP in EUR
    !pos3.partial_fill &&
    s3.booked_fills[CID] === 10,
    'final fill delta (3 more → 10/10 FILLED): qty=10, VWAP updated, partial_fill removed, watermark=10');
});

// ─── PB-05: Replay → idempotent (already_booked, no second position) ──────────
withEnv('pb05', initPortfolio(), ({ reload }) => {
  upsert(filledRec('pb05', { symbol: 'TSLA', qty: 3, px: 108 }));
  bookBrokerFills({ run_id: 'run_pb' });
  const after1 = reload();

  const sum2 = bookBrokerFills({ run_id: 'run_pb' });
  const after2 = reload();

  check('PB-05',
    sum2.booked_open === 0 && sum2.already_booked === 1 &&
    after2.open_positions.length === 1 &&
    JSON.stringify(after2.open_positions) === JSON.stringify(after1.open_positions) &&
    near(after2.cash, after1.cash),
    'replay: already_booked=1, position count unchanged, state unchanged');
});

// ─── PB-06: Acknowledged / submitted without fill → no booking ────────────────
withEnv('pb06', initPortfolio(), ({ reload }) => {
  const submittedRec  = { ...filledRec('pb06_sub'), state: ORDER_STATES.SUBMITTED,    filled_qty: 0 };
  const acknowledgedRec = { ...filledRec('pb06_ack'), state: ORDER_STATES.ACKNOWLEDGED, filled_qty: 0 };
  upsert(submittedRec);
  upsert(acknowledgedRec);

  const sum = bookBrokerFills({ run_id: 'run_pb' });
  const s   = reload();
  check('PB-06',
    sum.scanned === 2 && sum.eligible === 0 && sum.booked_open === 0 &&
    s.open_positions.length === 0,
    'submitted/acknowledged records → not eligible, no booking');
});

// ─── PB-07: Cancelled / rejected without fill → no booking ────────────────────
withEnv('pb07', initPortfolio(), ({ reload }) => {
  const rejRec = { ...filledRec('pb07_rej'), state: ORDER_STATES.REJECTED,   filled_qty: 0 };
  const expRec = { ...filledRec('pb07_exp'), state: ORDER_STATES.EXPIRED,    filled_qty: 0 };
  upsert(rejRec);
  upsert(expRec);

  const sum = bookBrokerFills({ run_id: 'run_pb' });
  const s   = reload();
  check('PB-07',
    sum.eligible === 0 && sum.booked_open === 0 &&
    s.open_positions.length === 0,
    'rejected/expired records → not eligible, no booking');
});

// ─── PB-08: PE-Fill (protect_v1_ CID, action=close) → exit booked correctly ───
//
// Protective-Exit orders are placed with action='close' and CID 'protect_v1_{sym}_{side}'.
// When the stop-order triggers and fills (FILLED), bookBrokerFills must close the position.
//
withEnv('pb08',
  (() => {
    const s = initPortfolio();
    // Pre-existing broker-filled position (e.g. from a previous dispatch fill)
    // Entry at 100 EUR, close via PE at 95 EUR → realized = -1 loss of 10 EUR for short
    // or use long: entry 100, stop hit at 92 EUR → realized = +1 * 2 * (92-100) = -16 EUR
    const entryUsd = 108;   // 100 EUR
    const stopUsd  = 99.36; // 92 EUR  (99.36 / 1.08 = 92)
    s.open_positions.push(
      openPos({ symbol: 'MSFT', side: 'long', qty: 2, entryUsd, cid: 'dispatch_v1_MSFT_long_buy' })
    );
    return s;
  })(),
  ({ reload }) => {
    const PE_CID = 'protect_v1_MSFT_long';
    const stopUsd = 99.36;  // 92 EUR stop price
    // PE record: action='close', CID follows protect_v1 scheme
    const peRec = {
      ...filledRec(PE_CID, { symbol: 'MSFT', side: 'long', action: 'close', qty: 2, px: stopUsd }),
    };
    upsert(peRec);

    const sum = bookBrokerFills({ run_id: 'run_pb' });
    const s   = reload();

    // realized = +1 * 2 * (92 - 100) = -16 EUR
    check('PB-08',
      sum.booked_close === 1 &&
      s.open_positions.length === 0 &&
      near(s.realized_pnl, -16) &&
      s.closed_positions_summary.count === 1 &&
      s.closed_positions_summary.losses === 1 &&
      s.booked_fills[PE_CID] === 2,
      'PE fill (protect_v1 CID, close action): position exited, realized -16 EUR, losses+1');
  }
);

// ─── PB-09: Default-Off → fill_sync.mjs unchanged (still skips PARTIALLY_FILLED) ─
//
// Verifies the Unit 10.5 FillSync module is NOT modified: it must still skip
// PARTIALLY_FILLED records. bookBrokerFills is the only path to book partial fills.
//
withEnv('pb09', initPortfolio(), ({ reload }) => {
  const CID = 'pb09';
  upsert(partialRec(CID, { symbol: 'AMD', totalQty: 5, filledQty: 2, px: 108 }));

  // Call the ORIGINAL fill_sync — must NOT book partial fills
  const sum = syncFillsToPortfolio({ run_id: 'run_pb' });
  const s   = reload();

  check('PB-09',
    sum.booked_open === 0 &&
    s.open_positions.length === 0 &&
    (s.booked_fills == null || s.booked_fills[CID] == null),
    'default-off: syncFillsToPortfolio skips PARTIALLY_FILLED → no booking (fill_sync unchanged)');
});

// ─── PB-10: Invalid / missing data → skip with reason, no mutation ────────────
withEnv('pb10', initPortfolio(), ({ reload }) => {
  // Bad record 1: FILLED but avg_fill_price missing
  const noPxRec = {
    ...filledRec('pb10_nopx', { qty: 1, px: 108 }),
    avg_fill_price: null,
  };
  // Bad record 2: FILLED but symbol is missing
  const noSymRec = {
    ...filledRec('pb10_nosym', { symbol: 'AAPL', qty: 1, px: 108 }),
    symbol: '',
  };
  upsert(noPxRec);
  upsert(noSymRec);

  const sum = bookBrokerFills({ run_id: 'run_pb' });
  const s   = reload();

  const skipReasons = sum.skips.map(sk => sk.reason);
  check('PB-10',
    sum.booked_open === 0 && sum.skipped === 2 &&
    skipReasons.includes('missing_or_invalid_fill_price') &&
    skipReasons.includes('missing_symbol') &&
    s.open_positions.length === 0 &&
    (s.booked_fills == null || Object.keys(s.booked_fills).length === 0),
    'invalid data (no fill_price, no symbol): both skipped with reasons, no portfolio mutation');
});

// ─── Summary ─────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nbroker_fill_booking_step28_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
