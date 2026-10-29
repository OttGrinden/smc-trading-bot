#!/usr/bin/env node
/**
 * BrokerCashPnlView + notional_eur bugfix — Unit 30 tests (CL-01 … CL-12).
 *
 * Two test styles:
 *   Booking tests (CL-01..CL-06, CL-09, CL-11):
 *     withEnv + bookBrokerFills() → deriveCashPnlView() reads the resulting state
 *   Injectable view tests (CL-07, CL-08, CL-10):
 *     hand-crafted state passed via opts._loadState (no disk I/O at all)
 *   Regression (CL-12):
 *     call existing booking + sync helpers to verify no regressions from the notional fix
 *
 * Price convention: USD = EUR × 1.08 (exact integer prices).
 *   108 USD → 100 EUR   (entry)
 *   118.8 USD → 110 EUR (close +10/sh)
 *   129.6 USD → 120 EUR (close +20/sh)
 *
 * node scripts/execution/tests/broker_cash_pnl_view_step30_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { makeBrokerOrderRecord, ORDER_STATES } from '../schemas.mjs';
import { upsert, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import {
  initPortfolio, loadOrInit, _setTestPaths, _clearTestPaths,
} from '../portfolio/portfolio_state.mjs';
import { bookBrokerFills }    from '../live_broker/broker_fill_booking.mjs';
import { syncFillsToPortfolio } from '../live_broker/fill_sync.mjs';
import { deriveCashPnlView }  from '../live_broker/broker_cash_pnl_view.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, ok: true  }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, ok: false }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

const ROOT = join(tmpdir(), `broker_cash_pnl_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

// ─── withEnv ─────────────────────────────────────────────────────────────────

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

  _setOrderStorePaths({ dir: storeDir, eventsLog: join(storeDir, 'ev.jsonl') });
  _setTestPaths(paths);
  try {
    return fn({
      reload: () => { _setOrderStorePaths({ dir: storeDir, eventsLog: join(storeDir, 'ev.jsonl') }); _setTestPaths(paths); return loadOrInit(); },
      view:   ()  => { _setOrderStorePaths({ dir: storeDir, eventsLog: join(storeDir, 'ev.jsonl') }); _setTestPaths(paths); return deriveCashPnlView(); },
    });
  } finally {
    _clearOrderStorePaths();
    _clearTestPaths();
  }
}

// ─── Record factories ─────────────────────────────────────────────────────────

function filledRec(cid, { symbol = 'AAPL', side = 'long', action = 'open', qty = 2, px = 108 } = {}) {
  const orderAction = action === 'open'
    ? (side === 'long' ? 'buy' : 'sell_short')
    : (side === 'long' ? 'sell' : 'buy_to_cover');
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol, side, asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_cl', action, order_action: orderAction, qty },
  );
  return {
    ...r,
    state: 'filled', filled_qty: qty, remaining_qty: 0,
    avg_fill_price: px, last_applied_filled_qty: qty,
    broker_order_id: 'b_' + cid, terminal_at: '2026-07-22T09:00:00.000Z',
  };
}

function partialRec(cid, { symbol = 'AAPL', side = 'long', action = 'close', totalQty = 10, filledQty = 3, px = 108 } = {}) {
  const orderAction = action === 'open'
    ? (side === 'long' ? 'buy' : 'sell_short')
    : (side === 'long' ? 'sell' : 'buy_to_cover');
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol, side, asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_cl', action, order_action: orderAction, qty: totalQty },
  );
  return {
    ...r,
    state: 'partially_filled', filled_qty: filledQty, remaining_qty: totalQty - filledQty,
    avg_fill_price: px, last_applied_filled_qty: filledQty,
    broker_order_id: 'b_' + cid, terminal_at: null,
  };
}

/** Pre-seeded open position at entry 100 EUR (108 USD). */
function openPos({ symbol = 'AAPL', side = 'long', qty = 10, entryUsd = 108 } = {}) {
  const entryEur = +(entryUsd / 1.08).toFixed(6);
  return {
    symbol, asset_type: 'stock', side, quantity: qty,
    notional_eur:       +(qty * entryEur).toFixed(4),
    entry_price_usd:    entryUsd,
    entry_price_eur:    entryEur,
    mark_price_usd:     entryUsd,
    mark_price_eur:     entryEur,
    unrealized_pnl_eur: 0,
    stop_loss_pct: 8, leverage: 1,
    entry_timestamp: '2026-07-22T08:00:00.000Z',
    entry_run_id: 'run_prev', strategy: 'broker_fill',
    order_id: 'open_' + symbol, booked_from: 'broker_fill', mark_source: 'broker_fill',
  };
}

// ─── CL-01: Open fill → cash_free decreases by notional ──────────────────────
// AAPL long 2sh @ 100 EUR → committed = 200, cash_free = 1800.
withEnv('cl01', initPortfolio(), ({ view }) => {
  upsert(filledRec('cl01_open', { symbol: 'AAPL', action: 'open', qty: 2, px: 108 }));
  bookBrokerFills({ run_id: 'run_cl' });
  const v = view();

  check('CL-01',
    v.ok &&
    near(v.cash_free,      1800) &&
    near(v.cash_committed,  200) &&
    near(v.realized_pnl,      0) &&
    near(v.unrealized_pnl,    0) &&  // mark = entry → unreal = 0
    near(v.nav,            2000) &&
    v.positions_count === 1 &&
    v.positions[0].mark_quality === 'available',
    'open fill 2sh@100: cash_free=1800, committed=200, realized=0, unreal=0, nav=2000');
});

// ─── CL-02: Full close → cash_free + realized PnL ────────────────────────────
// Existing position 2sh @100; close at 120 EUR → realized +40.
withEnv('cl02',
  (() => { const s = initPortfolio(); s.open_positions.push(openPos({ qty: 2, entryUsd: 108 })); return s; })(),
  ({ view }) => {
    upsert(filledRec('cl02_close', { symbol: 'AAPL', action: 'close', qty: 2, px: 129.6 }));
    bookBrokerFills({ run_id: 'run_cl' });
    const v = view();

    check('CL-02',
      v.ok &&
      near(v.cash_free,     2040) &&  // 2000 + 40
      near(v.cash_committed,   0) &&
      near(v.realized_pnl,    40) &&
      near(v.unrealized_pnl,   0) &&
      near(v.nav,           2040) &&
      v.positions_count === 0,
      'full close 2sh@120: cash_free=2040, committed=0, realized=40, nav=2040');
  }
);

// ─── CL-03: Partial close → delta cash + realized PnL (notional fix verified) ─
// 10sh @ 100 EUR open; partial close 3sh @ 110 EUR.
// With notional fix: notional = 7 * 100 = 700; cash_free = 2000 + 30 - 700 = 1330.
// unrealized = 7 * (110 - 100) = 70; nav = 2000 + 30 + 70 = 2100.
withEnv('cl03',
  (() => { const s = initPortfolio(); s.open_positions.push(openPos({ qty: 10 })); return s; })(),
  ({ view }) => {
    upsert(partialRec('cl03_close', { symbol: 'AAPL', action: 'close', totalQty: 10, filledQty: 3, px: 118.8 }));
    bookBrokerFills({ run_id: 'run_cl' });
    const v = view();

    check('CL-03',
      v.ok &&
      near(v.cash_free,     1330) &&   // 2000 + 30 - 700
      near(v.cash_committed,  700) &&  // 7 * 100
      near(v.realized_pnl,    30) &&   // 3 * (110 - 100)
      near(v.unrealized_pnl,  70) &&   // 7 * (110 - 100)
      near(v.nav,           2100) &&   // 2000 + 30 + 70
      v.positions_count === 1 &&
      near(v.positions[0].notional_eur, 700),
      'partial close 3/10@110: cash_free=1330, committed=700, realized=30, unreal=70, nav=2100');
  }
);

// ─── CL-04: Replay → idempotent cash/PnL ─────────────────────────────────────
withEnv('cl04',
  (() => { const s = initPortfolio(); s.open_positions.push(openPos({ symbol: 'NVDA', qty: 10 })); return s; })(),
  ({ view }) => {
    upsert(partialRec('cl04_close', { symbol: 'NVDA', action: 'close', totalQty: 10, filledQty: 4, px: 118.8 }));
    bookBrokerFills({ run_id: 'run_cl' });
    const v1 = view();

    // Replay: same record
    bookBrokerFills({ run_id: 'run_cl' });
    const v2 = view();

    check('CL-04',
      v2.ok &&
      near(v2.cash_free,     v1.cash_free) &&
      near(v2.cash_committed, v1.cash_committed) &&
      near(v2.realized_pnl,  v1.realized_pnl) &&
      near(v2.unrealized_pnl, v1.unrealized_pnl) &&
      near(v2.nav,            v1.nav),
      'replay of partial close: cash/PnL view idempotent (second pass changes nothing)');
  }
);

// ─── CL-05: Non-bookable states → no cash/PnL mutation ───────────────────────
withEnv('cl05', initPortfolio(), ({ view }) => {
  const submittedRec = {
    ...filledRec('cl05_sub', { action: 'open', qty: 5, px: 108 }),
    state: ORDER_STATES.SUBMITTED, filled_qty: 0,
  };
  upsert(submittedRec);
  bookBrokerFills({ run_id: 'run_cl' });
  const v = view();

  check('CL-05',
    v.ok &&
    near(v.cash_free,     2000) &&
    near(v.cash_committed,   0) &&
    near(v.realized_pnl,     0) &&
    near(v.unrealized_pnl,   0) &&
    near(v.nav,           2000) &&
    v.positions_count === 0,
    'submitted order: no cash/PnL change, view shows clean init state');
});

// ─── CL-06: realized PnL in view exactly consistent with broker_fill_booking ──
// Full lifecycle: open 5sh + partial close 2sh + full close 3sh.
// Realized = 2*(115-100) + 3*(120-100) = 30 + 60 = 90.
withEnv('cl06', initPortfolio(), ({ reload, view }) => {
  // Step 1: open 5sh @ 100 EUR
  upsert(filledRec('cl06_open', { symbol: 'KLAC', action: 'open', qty: 5, px: 108 }));
  bookBrokerFills({ run_id: 'run_cl' });

  // Step 2: partial close 2sh @ 115 EUR (2 × 15 = 30)
  upsert(partialRec('cl06_close', { symbol: 'KLAC', action: 'close', totalQty: 5, filledQty: 2, px: 124.2 }));
  bookBrokerFills({ run_id: 'run_cl' });

  // Step 3: final close 3sh @ 120 EUR  (3 × 20 = 60; total realized = 90)
  const finalRec = filledRec('cl06_close', { symbol: 'KLAC', action: 'close', qty: 5, px: 129.6 });
  upsert(finalRec);
  bookBrokerFills({ run_id: 'run_cl' });

  const s = reload();
  const v = view();

  check('CL-06',
    v.ok &&
    near(v.realized_pnl, 90) &&
    near(v.realized_pnl, s.realized_pnl) &&   // view == state (consistency)
    near(v.cash_free, 2000 + 90) &&           // 2090
    v.positions_count === 0,
    'open + partial-close + full-close: realized_pnl=90, view==state, cash_free=2090');
});

// ─── CL-07: Unrealized PnL from mark price (injectable) ──────────────────────
// Position 5sh long @ 100 EUR entry, mark at 120 EUR → unrealized = 5 * 20 = 100.
{
  const state = {
    ...initPortfolio(),
    open_positions: [{
      symbol: 'AMD', side: 'long', quantity: 5,
      notional_eur:     500,
      entry_price_eur:  100,
      entry_price_usd:  108,
      mark_price_eur:   120,
      mark_price_usd:   129.6,
      unrealized_pnl_eur: 0,
    }],
    unrealized_pnl: 100,
    cash:  1500,   // 2000 - 500
    equity_nav: 2100,
  };

  const v = deriveCashPnlView({ _loadState: () => state });

  check('CL-07',
    v.ok &&
    near(v.unrealized_pnl, 100) &&
    near(v.cash_free,     1500) &&
    near(v.nav,           2100) &&
    v.positions[0].mark_quality === 'available' &&
    near(v.positions[0].unrealized_pnl_eur, 100),
    'unrealized PnL from valid mark: 5sh×(120-100)=100, mark_quality=available');
}

// ─── CL-08: Missing mark → conservative unrealized = 0, mark_quality flagged ──
{
  const state = {
    ...initPortfolio(),
    open_positions: [{
      symbol: 'MU', side: 'long', quantity: 5,
      notional_eur:    500,
      entry_price_eur: 100,
      entry_price_usd: 108,
      mark_price_eur:  null,   // no mark available
      mark_price_usd:  null,
      unrealized_pnl_eur: 0,
    }],
    unrealized_pnl: 0,
    cash:  1500,
    equity_nav: 2000,
  };

  const v = deriveCashPnlView({ _loadState: () => state });

  check('CL-08',
    v.ok &&
    near(v.unrealized_pnl, 0) &&           // conservative
    near(v.nav, 2000) &&                   // no phantom unrealized inflating NAV
    v.positions[0].mark_quality === 'no_mark_unavailable' &&
    near(v.positions[0].unrealized_pnl_eur, 0),
    'missing mark: unrealized_pnl=0 (conservative), mark_quality=no_mark_unavailable');
}

// ─── CL-09: View consistent with state after any booking pass ────────────────
// After bookBrokerFills() (which calls recompute + save), the stored fields must
// match the derived fields → ok=true on every check.
withEnv('cl09',
  (() => { const s = initPortfolio(); s.open_positions.push(openPos({ symbol: 'ASML', qty: 3 })); return s; })(),
  ({ view }) => {
    // Open partial close (updates notional, recomputes, saves)
    upsert(partialRec('cl09_close', { symbol: 'ASML', action: 'close', totalQty: 3, filledQty: 1, px: 118.8 }));
    bookBrokerFills({ run_id: 'run_cl' });
    const v = view();

    check('CL-09',
      v.ok &&
      v.inconsistencies.length === 0 &&
      v.consistency_checks.cash.ok          &&
      v.consistency_checks.unrealized_pnl.ok &&
      v.consistency_checks.equity_nav.ok    &&
      v.consistency_checks.realized_pnl_vs_cs_total.ok,
      'after booking pass: all consistency checks pass, ok=true, no inconsistencies');
  }
);

// ─── CL-10: Inconsistency detection (deliberately corrupt cash field) ─────────
{
  const state = {
    ...initPortfolio(),
    open_positions: [],
    realized_pnl:  50,
    cash:          9999,    // should be 2000 + 50 = 2050, but deliberately wrong
    equity_nav:    2050,
    unrealized_pnl: 0,
    closed_positions_summary: { count: 1, wins: 1, losses: 0, realized_pnl_total: 50 },
  };

  const v = deriveCashPnlView({ _loadState: () => state });

  check('CL-10',
    !v.ok &&
    v.inconsistencies.length >= 1 &&
    v.inconsistencies.some(i => i.field === 'cash') &&
    v.consistency_checks.cash.ok === false,
    'corrupt cash field (9999 vs derived 2050): inconsistency detected, ok=false');
}

// ─── CL-11: Default-Off — existing paths unaffected ──────────────────────────
// Verify that calling syncFillsToPortfolio (Unit 10.5) and bookBrokerFills (Unit 28/29)
// does NOT automatically invoke deriveCashPnlView: summary shapes are unchanged.
withEnv('cl11', initPortfolio(), ({ reload }) => {
  upsert(filledRec('cl11_open', { symbol: 'AMAT', action: 'open', qty: 1, px: 108 }));
  const bfbSum = bookBrokerFills({ run_id: 'run_cl' });
  // bookBrokerFills summary must NOT contain any cash/pnl view fields
  check('CL-11a',
    'cash_free'      in bfbSum === false &&
    'realized_pnl'   in bfbSum === false &&
    'unrealized_pnl' in bfbSum === false &&
    'nav'            in bfbSum === false,
    'bookBrokerFills summary contains no cash/PnL view fields (default-off)');

  // Separately verify fill_sync similarly unchanged
  _setOrderStorePaths({ dir: join(ROOT, 'cl11', 'orders'), eventsLog: join(ROOT, 'cl11', 'orders', 'ev.jsonl') });
  _setTestPaths({
    state:   join(ROOT, 'cl11', 'state.json'),
    history: join(ROOT, 'cl11', 'hist.jsonl'),
    ledger:  join(ROOT, 'cl11', 'ledger.jsonl'),
  });
  const syncSum = syncFillsToPortfolio({ run_id: 'run_cl' });
  check('CL-11b',
    'cash_free'    in syncSum === false &&
    'nav'          in syncSum === false,
    'syncFillsToPortfolio summary contains no cash/PnL view fields (default-off)');
});

// ─── CL-12: Regression — existing booking paths unbroken by notional_eur fix ──
// Open 10sh; partial close 3sh; partial close 4sh; full close 3sh.
// Verify qty + realized are still correct (same as RC-12 scenario but also checks notional).
withEnv('cl12', initPortfolio(), ({ reload }) => {
  const CID = 'cl12_close';
  const OPEN_CID = 'cl12_open';

  // Open 10sh @ 100 EUR
  upsert(filledRec(OPEN_CID, { symbol: 'HII', action: 'open', qty: 10, px: 108 }));
  bookBrokerFills({ run_id: 'run_cl' });
  const s0 = reload();
  const pos0 = s0.open_positions.find(p => p.symbol === 'HII');
  check('CL-12a',
    near(pos0?.quantity, 10) && near(pos0?.notional_eur, 1000) && near(s0.cash, 1000),
    'open 10sh: notional=1000, cash=1000');

  // Partial close 3sh @ 110 EUR → realized=30, notional=700, cash=1330
  upsert(partialRec(CID, { symbol: 'HII', action: 'close', totalQty: 10, filledQty: 3, px: 118.8 }));
  bookBrokerFills({ run_id: 'run_cl' });
  const s1 = reload();
  const pos1 = s1.open_positions.find(p => p.symbol === 'HII');
  check('CL-12b',
    near(pos1?.quantity, 7) &&
    near(pos1?.notional_eur, 700) &&    // KEY: notional updated (bug fix)
    near(s1.realized_pnl, 30) &&
    near(s1.cash, 1330),                // 2000 + 30 - 700
    'partial close 3/10: qty=7, notional=700 (fix verified), realized=30, cash=1330');

  // Partial close 4sh @ 120 EUR → realized+=80, notional=300, cash=1710
  upsert(partialRec(CID, { symbol: 'HII', action: 'close', totalQty: 10, filledQty: 7, px: 129.6 }));
  bookBrokerFills({ run_id: 'run_cl' });
  const s2 = reload();
  const pos2 = s2.open_positions.find(p => p.symbol === 'HII');
  check('CL-12c',
    near(pos2?.quantity, 3) &&
    near(pos2?.notional_eur, 300) &&    // 3 * 100
    near(s2.realized_pnl, 110) &&       // 30 + 80
    near(s2.cash, 1810),                // 2000 + 110 - 300
    'partial close 4 more: qty=3, notional=300, realized=110, cash=1810');

  // Final close 3sh @ 110 EUR → realized+=30=140; position removed; cash=2140
  const finalRec = filledRec(CID, { symbol: 'HII', action: 'close', qty: 10, px: 118.8 });
  upsert(finalRec);
  bookBrokerFills({ run_id: 'run_cl' });
  const s3 = reload();
  check('CL-12d',
    s3.open_positions.length === 0 &&
    near(s3.realized_pnl, 140) &&
    near(s3.cash, 2140) &&              // 2000 + 140 - 0
    s3.closed_positions_summary.count === 1 &&
    s3.closed_positions_summary.wins === 1,
    'final close: position removed, realized=140, cash=2140, cs.count=1, wins=1');
});

// ─── Summary ─────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => !r.ok).length;
process.stderr.write(`\nbroker_cash_pnl_view_step30_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
