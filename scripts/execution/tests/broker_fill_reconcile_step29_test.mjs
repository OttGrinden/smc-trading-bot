#!/usr/bin/env node
/**
 * BrokerFillReconcile + Partial-Close — Unit 29 tests (RC-01 … RC-12).
 *
 * Two test styles:
 *   - Booking tests (RC-02..RC-04, RC-07..RC-12):  withEnv (real temp files, fully offline)
 *   - Reconciliation tests (RC-01, RC-05..RC-06):  injectable opts (no file system at all)
 *
 * Price convention: USD = EUR × 1.08 so EUR values are exact.
 *   108 USD → 100 EUR ; 129.6 USD → 120 EUR ; 216 USD → 200 EUR
 *
 * node scripts/execution/tests/broker_fill_reconcile_step29_test.mjs
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
import { reconcileBrokerFills } from '../live_broker/broker_fill_reconcile.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

const ROOT = join(tmpdir(), `broker_fill_reconcile_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

// ─── withEnv (booking tests) ─────────────────────────────────────────────────

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

function filledRec(cid, { symbol = 'AAPL', side = 'long', action = 'open', qty = 2, px = 108 } = {}) {
  const orderAction = action === 'open'
    ? (side === 'long' ? 'buy' : 'sell_short')
    : (side === 'long' ? 'sell' : 'buy_to_cover');
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol, side, asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_rc', action, order_action: orderAction, qty },
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

function partialRec(cid, { symbol = 'AAPL', side = 'long', action = 'close', totalQty = 10, filledQty = 3, px = 108 } = {}) {
  const orderAction = action === 'open'
    ? (side === 'long' ? 'buy' : 'sell_short')
    : (side === 'long' ? 'sell' : 'buy_to_cover');
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol, side, asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_rc', action, order_action: orderAction, qty: totalQty },
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

/** Pre-seeded open position at entry 100 EUR (108 USD). */
function openPos({ symbol = 'AAPL', side = 'long', qty = 10, entryUsd = 108, cid = null } = {}) {
  const entryEur = +(entryUsd / 1.08).toFixed(6);
  return {
    symbol, asset_type: 'stock', side, quantity: qty,
    notional_eur:       +(qty * entryEur).toFixed(4),
    entry_price_usd:    entryUsd,
    entry_price_eur:    entryEur,
    mark_price_usd:     entryUsd,
    mark_price_eur:     entryEur,
    unrealized_pnl_eur: 0, stop_loss_pct: 8, leverage: 1,
    entry_timestamp:    '2026-07-22T07:00:00.000Z',
    entry_run_id:       'run_prev',
    strategy:           'broker_fill',
    order_id:           cid ?? ('open_' + symbol),
    booked_from:        'broker_fill',
    mark_source:        'broker_fill',
  };
}

// ─── RC-01: Reconciliation clean on consistent open → close flow ──────────────
//
// Fully booked FILLED open + FILLED close; portfolio has no open positions.
// Expected: both records reconciled, no mismatch, no unresolved.
//
{
  const OPEN_CID  = 'rc01_open';
  const CLOSE_CID = 'rc01_close';
  // Pre-computed state: open booked, position then closed (position removed)
  const stateSnap = {
    ...initPortfolio(),
    booked_fills:  { [OPEN_CID]: 2, [CLOSE_CID]: 2 },
    open_positions: [],
    realized_pnl:   40,
  };
  const openRecData  = filledRec(OPEN_CID,  { symbol: 'AAPL', action: 'open',  qty: 2, px: 108 });
  const closeRecData = filledRec(CLOSE_CID, { symbol: 'AAPL', action: 'close', qty: 2, px: 129.6 });

  let report = null;
  let threw  = false;
  try {
    report = reconcileBrokerFills({
      _listAll:   () => [openRecData, closeRecData],
      _loadState: () => stateSnap,
    });
  } catch (e) { threw = true; process.stderr.write('  ERR RC-01: ' + e.message + '\n'); }

  check('RC-01',
    !threw &&
    report?.mismatch_count   === 0 &&
    report?.unresolved_count === 0 &&
    report?.reconciled_count === 2 &&
    report?.reconciled.some(r => r.cid === OPEN_CID  && r.note === 'position_subsequently_closed') &&
    report?.reconciled.some(r => r.cid === CLOSE_CID && r.note === 'position_closed'),
    'clean open→close: both records reconciled, no mismatch, no unresolved');
}

// ─── RC-02: Partial-close booking reduces position correctly ──────────────────
//
// Position qty=10. Close order PARTIALLY_FILLED at 3.
// After bookBrokerFills: position qty should be 7, partial_realized_eur set.
//
withEnv('rc02',
  (() => {
    const s = initPortfolio();
    s.open_positions.push(openPos({ symbol: 'AAPL', qty: 10, entryUsd: 108 }));
    return s;
  })(),
  ({ reload }) => {
    const CLOSE_CID = 'rc02_close';
    // 3 shares closed at 118.8 USD = 110 EUR → delta realized = 1 * 3 * (110 - 100) = +30 EUR
    upsert(partialRec(CLOSE_CID, { symbol: 'AAPL', action: 'close', totalQty: 10, filledQty: 3, px: 118.8 }));
    const sum = bookBrokerFills({ run_id: 'run_rc' });
    const s   = reload();
    const pos = s.open_positions.find(p => p.symbol === 'AAPL' && p.side === 'long');

    check('RC-02',
      sum.booked_partial_close === 1 && sum.booked_close === 0 &&
      pos != null &&
      near(pos.quantity, 7) &&
      near(s.realized_pnl, 30) &&
      s.closed_positions_summary.count === 0 &&   // position not fully closed yet
      s.booked_fills[CLOSE_CID] === 3 &&
      near(pos.partial_realized_eur, 30),
      'partial-close 3/10: position reduced to 7, realized +30, cs.count=0, partial_realized_eur=30, watermark=3');
  }
);

// ─── RC-03: Multiple partial-close steps → delta-based reduction ──────────────
//
// Position qty=10. Three partial-close steps: 3 + 4 + 2 = 9.
// After all three: position qty = 1, realized = 3×10 + 4×20 + 2×10 = 30+80+20 = 130 EUR.
// Entry: 100 EUR. Close prices: 110 (3sh), 120 (4sh), 110 (2sh).
//
withEnv('rc03',
  (() => {
    const s = initPortfolio();
    s.open_positions.push(openPos({ symbol: 'TSLA', qty: 10, entryUsd: 108 }));
    return s;
  })(),
  ({ reload }) => {
    const CLOSE_CID = 'rc03_close';

    // Step 1: 3/10 at 118.8 USD = 110 EUR → realized = 3*(110-100) = +30
    upsert(partialRec(CLOSE_CID, { symbol: 'TSLA', action: 'close', totalQty: 10, filledQty: 3, px: 118.8 }));
    const sum1 = bookBrokerFills({ run_id: 'run_rc' });
    const s1   = reload();
    const pos1 = s1.open_positions.find(p => p.symbol === 'TSLA');
    check('RC-03a',
      sum1.booked_partial_close === 1 && near(pos1?.quantity, 7) && near(s1.realized_pnl, 30),
      'step 1 (3/10): position=7, realized=30');

    // Step 2: 7/10 (delta 4) at 129.6 USD = 120 EUR → realized += 4*(120-100) = +80 → total 110
    upsert(partialRec(CLOSE_CID, { symbol: 'TSLA', action: 'close', totalQty: 10, filledQty: 7, px: 129.6 }));
    const sum2 = bookBrokerFills({ run_id: 'run_rc' });
    const s2   = reload();
    const pos2 = s2.open_positions.find(p => p.symbol === 'TSLA');
    check('RC-03b',
      sum2.booked_partial_close === 1 && near(pos2?.quantity, 3) && near(s2.realized_pnl, 110),
      'step 2 (4 more → 7/10): position=3, realized=110');

    // Step 3: 9/10 (delta 2) at 118.8 USD = 110 EUR → realized += 2*(110-100) = +20 → total 130
    upsert(partialRec(CLOSE_CID, { symbol: 'TSLA', action: 'close', totalQty: 10, filledQty: 9, px: 118.8 }));
    const sum3 = bookBrokerFills({ run_id: 'run_rc' });
    const s3   = reload();
    const pos3 = s3.open_positions.find(p => p.symbol === 'TSLA');
    check('RC-03c',
      sum3.booked_partial_close === 1 && near(pos3?.quantity, 1) && near(s3.realized_pnl, 130) &&
      s3.closed_positions_summary.count === 0 && s3.booked_fills[CLOSE_CID] === 9,
      'step 3 (2 more → 9/10): position=1, realized=130, cs.count still 0, watermark=9');
  }
);

// ─── RC-04: Replay of partial-close → no double-booking ──────────────────────
withEnv('rc04',
  (() => {
    const s = initPortfolio();
    s.open_positions.push(openPos({ symbol: 'NVDA', qty: 10, entryUsd: 108 }));
    return s;
  })(),
  ({ reload }) => {
    const CLOSE_CID = 'rc04_close';
    upsert(partialRec(CLOSE_CID, { symbol: 'NVDA', action: 'close', totalQty: 10, filledQty: 4, px: 118.8 }));

    bookBrokerFills({ run_id: 'run_rc' });
    const after1 = reload();

    // Replay: same record still at filledQty=4
    const sum2 = bookBrokerFills({ run_id: 'run_rc' });
    const after2 = reload();

    check('RC-04',
      sum2.already_booked === 1 && sum2.booked_partial_close === 0 &&
      near(after2.realized_pnl, after1.realized_pnl) &&
      after2.open_positions.length === after1.open_positions.length &&
      after2.booked_fills[CLOSE_CID] === after1.booked_fills[CLOSE_CID],
      'replay partial-close: already_booked=1, no double-booking, state unchanged');
  }
);

// ─── RC-05: Fill ahead of booking → mismatch:fill_not_yet_booked ─────────────
//
// FILLED open record with filledQty=5, but booked_fills has no entry.
//
{
  const CID = 'rc05_open';
  const rec = filledRec(CID, { symbol: 'MSFT', action: 'open', qty: 5, px: 108 });
  const stateSnap = {
    ...initPortfolio(),
    booked_fills:   {},   // nothing booked yet
    open_positions: [],
  };

  let report = null;
  try {
    report = reconcileBrokerFills({
      _listAll:   () => [rec],
      _loadState: () => stateSnap,
    });
  } catch (e) { process.stderr.write('  ERR RC-05: ' + e.message + '\n'); }

  const mm = report?.mismatch?.[0];
  check('RC-05',
    report?.mismatch_count   === 1 &&
    report?.reconciled_count === 0 &&
    mm?.cid    === CID &&
    mm?.reason === 'fill_not_yet_booked' &&
    mm?.unfilled_delta === 5,
    'fill ahead of booking → mismatch:fill_not_yet_booked with unfilled_delta=5');
}

// ─── RC-06: Orphan booking → unresolved:orphan_booking ───────────────────────
//
// booked_fills has an entry for a CID that no longer exists in OrderStore
// (record was deleted via cleanup after a fully settled fill).
//
{
  const OLD_CID = 'rc06_old';
  const stateSnap = {
    ...initPortfolio(),
    booked_fills:   { [OLD_CID]: 3 },  // booking remains
    open_positions: [],
  };

  let report = null;
  try {
    report = reconcileBrokerFills({
      _listAll:   () => [],   // store is empty (record deleted)
      _loadState: () => stateSnap,
    });
  } catch (e) { process.stderr.write('  ERR RC-06: ' + e.message + '\n'); }

  const ur = report?.unresolved?.[0];
  check('RC-06',
    report?.unresolved_count === 1 &&
    report?.mismatch_count   === 0 &&
    ur?.cid    === OLD_CID &&
    ur?.reason === 'orphan_booking' &&
    ur?.booked_qty === 3,
    'orphan booking (record deleted, booking remains) → unresolved:orphan_booking');
}

// ─── RC-07: Non-bookable states → no mutation ─────────────────────────────────
withEnv('rc07', initPortfolio(), ({ reload }) => {
  const CID = 'rc07_sub';
  // SUBMITTED close record: not in BOOKABLE_STATES
  const subRec = { ...filledRec(CID, { action: 'close', qty: 5, px: 108 }),
    state: ORDER_STATES.SUBMITTED, filled_qty: 0 };
  upsert(subRec);

  const sum = bookBrokerFills({ run_id: 'run_rc' });
  const s   = reload();

  // Reconciliation: no booking, no position → no mismatch (unless booking existed)
  const stateSnap = { ...s, booked_fills: s.booked_fills ?? {} };
  let report = null;
  try {
    report = reconcileBrokerFills({
      _listAll:   () => [subRec],
      _loadState: () => stateSnap,
    });
  } catch (e) { process.stderr.write('  ERR RC-07-reconcile: ' + e.message + '\n'); }

  check('RC-07',
    sum.eligible === 0 && sum.booked_partial_close === 0 && sum.booked_close === 0 &&
    s.open_positions.length === 0 &&
    report?.mismatch_count === 0 && report?.unresolved_count === 0,
    'non-bookable submitted record: no booking, no mutation, no reconciliation mismatch');
});

// ─── RC-08: Invalid fill data → conservative skip, no mutation ───────────────
//
// PARTIALLY_FILLED close with: (a) missing avg_fill_price, (b) delta would exceed position.
//
withEnv('rc08',
  (() => {
    const s = initPortfolio();
    s.open_positions.push(openPos({ symbol: 'AMD', qty: 5, entryUsd: 108 }));
    return s;
  })(),
  ({ reload }) => {
    // (a) missing price
    const noPxRec = { ...partialRec('rc08_nopx', { symbol: 'AMD', action: 'close', totalQty: 5, filledQty: 2, px: 108 }),
      avg_fill_price: null };
    // (b) overshoot: position qty=5, but close delta=6 (exceeds position)
    const overshootRec = partialRec('rc08_over', { symbol: 'AMD', action: 'close', totalQty: 10, filledQty: 6, px: 108 });
    upsert(noPxRec);
    upsert(overshootRec);

    const sum = bookBrokerFills({ run_id: 'run_rc' });
    const s   = reload();
    const pos = s.open_positions.find(p => p.symbol === 'AMD');

    const skipReasons = sum.skips.map(sk => sk.reason);
    check('RC-08',
      sum.skipped === 2 && sum.booked_partial_close === 0 && sum.booked_close === 0 &&
      skipReasons.includes('missing_or_invalid_fill_price') &&
      skipReasons.includes('close_would_exceed_position') &&
      pos != null && near(pos.quantity, 5),   // position untouched
      'invalid close data: (a) missing price skipped, (b) overshoot skipped; position unchanged');
  }
);

// ─── RC-09: Default-off → fill_sync unchanged (still skips PARTIALLY_FILLED close) ─
import { syncFillsToPortfolio } from '../live_broker/fill_sync.mjs';

withEnv('rc09',
  (() => {
    const s = initPortfolio();
    s.open_positions.push(openPos({ symbol: 'INTC', qty: 5, entryUsd: 108 }));
    return s;
  })(),
  ({ reload }) => {
    const CID = 'rc09_close';
    upsert(partialRec(CID, { symbol: 'INTC', action: 'close', totalQty: 5, filledQty: 2, px: 118.8 }));

    // Original fill_sync: must still skip PARTIALLY_FILLED close
    const sum = syncFillsToPortfolio({ run_id: 'run_rc' });
    const s   = reload();
    const pos = s.open_positions.find(p => p.symbol === 'INTC');

    check('RC-09',
      sum.eligible === 0 && sum.booked_close === 0 &&
      pos != null && near(pos.quantity, 5) &&
      (s.booked_fills == null || s.booked_fills[CID] == null),
      'default-off: fill_sync skips PARTIALLY_FILLED close; position unchanged, no watermark set');
  }
);

// ─── RC-10: Protective-Exit close fill → correctly booked ────────────────────
//
// PE stop-order fills (CID protect_v1_*), action=close, state=FILLED.
// Position qty=3 at 100 EUR; PE fires at 92 EUR → realized = 1*3*(92-100) = -24 EUR.
//
withEnv('rc10',
  (() => {
    const s = initPortfolio();
    s.open_positions.push(openPos({ symbol: 'AMAT', qty: 3, entryUsd: 108, cid: 'dispatch_v1_AMAT_long_buy' }));
    return s;
  })(),
  ({ reload }) => {
    const PE_CID = 'protect_v1_AMAT_long';
    upsert(filledRec(PE_CID, { symbol: 'AMAT', side: 'long', action: 'close', qty: 3, px: 99.36 }));

    const sum = bookBrokerFills({ run_id: 'run_rc' });
    const s   = reload();

    check('RC-10',
      sum.booked_close === 1 &&
      s.open_positions.length === 0 &&
      near(s.realized_pnl, -24) &&     // 1*3*(92-100) = -24
      s.closed_positions_summary.count === 1 &&
      s.closed_positions_summary.losses === 1 &&
      s.booked_fills[PE_CID] === 3,
      'PE close fill (protect_v1 CID): position exited, realized -24 EUR, losses+1');
  }
);

// ─── RC-11: Restposition after partial-close exactly matches expected delta ───
//
// Position qty=10. Partial-close steps: 3+4=7 closed. Remaining must be exactly 3.
//
withEnv('rc11',
  (() => {
    const s = initPortfolio();
    s.open_positions.push(openPos({ symbol: 'KLAC', qty: 10, entryUsd: 108 }));
    return s;
  })(),
  ({ reload }) => {
    const CLOSE_CID = 'rc11_close';

    upsert(partialRec(CLOSE_CID, { symbol: 'KLAC', action: 'close', totalQty: 10, filledQty: 3, px: 118.8 }));
    bookBrokerFills({ run_id: 'run_rc' });

    upsert(partialRec(CLOSE_CID, { symbol: 'KLAC', action: 'close', totalQty: 10, filledQty: 7, px: 129.6 }));
    bookBrokerFills({ run_id: 'run_rc' });

    const s   = reload();
    const pos = s.open_positions.find(p => p.symbol === 'KLAC');

    // Expected remaining: 10 - 7 = 3 (watermark = 7)
    check('RC-11',
      pos != null &&
      near(pos.quantity, 3, 1e-6) &&
      s.booked_fills[CLOSE_CID] === 7 &&
      s.closed_positions_summary.count === 0 &&
      near(s.realized_pnl, 30 + 80),   // 3*(110-100) + 4*(120-100) = 30+80 = 110
      'restposition after 7/10 partial-close: qty=3 (exact), realized=110, cs.count=0, watermark=7');
  }
);

// ─── RC-12: Final full-close after partials → consistently closed ─────────────
//
// Continue from RC-11 pattern: 3+4 already closed. Final 3 → FILLED → position removed.
//
withEnv('rc12',
  (() => {
    const s = initPortfolio();
    s.open_positions.push(openPos({ symbol: 'MU', qty: 10, entryUsd: 108 }));
    return s;
  })(),
  ({ reload }) => {
    const CLOSE_CID = 'rc12_close';

    // Step 1: 3/10 at 110 EUR → realized = +30
    upsert(partialRec(CLOSE_CID, { symbol: 'MU', action: 'close', totalQty: 10, filledQty: 3, px: 118.8 }));
    bookBrokerFills({ run_id: 'run_rc' });

    // Step 2: 7/10 (delta 4) at 120 EUR → realized += +80 → total 110
    upsert(partialRec(CLOSE_CID, { symbol: 'MU', action: 'close', totalQty: 10, filledQty: 7, px: 129.6 }));
    bookBrokerFills({ run_id: 'run_rc' });

    // Step 3: FILLED at 10/10 (delta 3) at 110 EUR → realized += +30 → total 140; cs.count=1
    const finalRec = filledRec(CLOSE_CID, { symbol: 'MU', side: 'long', action: 'close', qty: 10, px: 118.8 });
    upsert(finalRec);
    const sum3 = bookBrokerFills({ run_id: 'run_rc' });
    const s    = reload();

    check('RC-12',
      sum3.booked_close === 1 && sum3.booked_partial_close === 0 &&
      s.open_positions.length === 0 &&
      near(s.realized_pnl, 140) &&     // 30+80+30 = 140
      s.closed_positions_summary.count === 1 &&
      s.closed_positions_summary.wins === 1 &&   // total partial_realized_eur = 140 ≥ 0
      s.booked_fills[CLOSE_CID] === 10,
      'final FILLED close after 7 partials: position removed, realized=140, cs.count=1, wins=1, watermark=10');
  }
);

// ─── Summary ─────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nbroker_fill_reconcile_step29_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
