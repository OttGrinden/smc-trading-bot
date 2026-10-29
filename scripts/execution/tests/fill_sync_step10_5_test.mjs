#!/usr/bin/env node
/**
 * FillSync — Phase 1 / Unit 10.5 booking tests (FS-01 … FS-11).
 *
 * Isolated + deterministic + offline:
 *   - order records live in a temp store dir (_setOrderStorePaths)
 *   - portfolio state/ledger live in temp files (_setTestPaths)
 *   - no broker IO, no network, no live state touched
 *
 * Prices are chosen as USD multiples of EUR_USD_RATE (1.08) so EUR values are exact:
 *   108 USD → 100 EUR ; 129.6 USD → 120 EUR.
 *
 * node scripts/execution/tests/fill_sync_step10_5_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { join }  from 'path';
import { tmpdir } from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import {
  initPortfolio, loadOrInit, _setTestPaths, _clearTestPaths,
} from '../portfolio/portfolio_state.mjs';
import { syncFillsToPortfolio } from '../live_broker/fill_sync.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────
const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

const ROOT = join(tmpdir(), `fillsync_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

/**
 * Build an isolated env (store dir + portfolio paths) for one test case.
 * The path overrides stay active for the ENTIRE block (cleared once in finally),
 * so multiple sync passes + reloads all hit the temp files — never production.
 * `reload()` re-asserts the full override and reads the temp state.
 */
function withEnv(tag, initialState, fn) {
  const base = join(ROOT, tag);
  const storeDir = join(base, 'orders');
  mkdirSync(storeDir, { recursive: true });
  const statePath = join(base, 'state.json');
  const paths = { state: statePath, history: join(base, 'hist.jsonl'), ledger: join(base, 'ledger.jsonl') };
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

/** A fully FILLED broker record. */
function filledRec(cid, { symbol = 'AMAT', side = 'long', action = 'open', qty = 2, px = 108 } = {}) {
  const orderAction = action === 'open'
    ? (side === 'long' ? 'buy' : 'sell_short')
    : (side === 'long' ? 'sell' : 'buy_to_cover');
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol, side, asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_fs', action, order_action: orderAction, qty },
  );
  return {
    ...r,
    state: 'filled',
    filled_qty: qty,
    remaining_qty: 0,
    avg_fill_price: px,
    last_applied_filled_qty: qty,
    broker_order_id: 'b_' + cid,
    terminal_at: '2026-06-18T08:00:00.000Z',
  };
}

/** An open position as the portfolio would hold it. */
function openPos({ symbol = 'AMAT', side = 'long', qty = 2, entryUsd = 108 } = {}) {
  const entryEur = +(entryUsd / 1.08).toFixed(6);
  return {
    symbol, asset_type: 'stock', side, quantity: qty,
    notional_eur: +(qty * entryEur).toFixed(4),
    entry_price_usd: entryUsd, entry_price_eur: entryEur,
    mark_price_usd: entryUsd, mark_price_eur: entryEur,
    unrealized_pnl_eur: 0, stop_loss_pct: 8, leverage: 1,
    entry_timestamp: '2026-06-01T00:00:00.000Z', entry_run_id: 'run_prev',
    strategy: 'broker_fill', order_id: 'open_' + symbol,
  };
}

// ─── FS-01: open fill booked → position created, cash reduced, watermark set ───
withEnv('fs01', initPortfolio(), ({ statePath, reload }) => {
  upsert(filledRec('cid_fs01', { symbol: 'AMAT', side: 'long', action: 'open', qty: 2, px: 108 }));
  const sum = syncFillsToPortfolio({ run_id: 'run_fs' });
  const s = reload();
  const pos = s.open_positions.find(p => p.symbol === 'AMAT' && p.side === 'long');
  check('FS-01',
    sum.booked_open === 1 && s.open_positions.length === 1 && pos &&
    near(pos.entry_price_eur, 100) && near(pos.notional_eur, 200) &&
    near(s.cash, 2000 - 200) && near(s.equity_nav, 2000) &&
    s.booked_fills['cid_fs01'] === 2 && pos.booked_from === 'broker_fill',
    'open fill → 1 position (entry 100 EUR, notional 200), cash 1800, NAV 2000, watermark=2');
});

// ─── FS-02: idempotency — second sync is a no-op (no double position) ──────────
withEnv('fs02', initPortfolio(), ({ statePath, reload }) => {
  upsert(filledRec('cid_fs02', { qty: 2, px: 108 }));
  syncFillsToPortfolio({ run_id: 'run_fs' });
  const first = reload();
  const sum2 = syncFillsToPortfolio({ run_id: 'run_fs' });
  const second = reload();
  check('FS-02',
    sum2.booked_open === 0 && sum2.already_booked === 1 &&
    second.open_positions.length === 1 &&
    near(second.realized_pnl, first.realized_pnl) &&
    JSON.stringify(second.open_positions) === JSON.stringify(first.open_positions),
    'second sync: already_booked=1, no second position, state unchanged');
});

// ─── FS-03: long close fill booked → position removed, realized PnL correct ────
withEnv('fs03', (() => { const s = initPortfolio(); s.open_positions.push(openPos({ symbol: 'AMAT', side: 'long', qty: 2, entryUsd: 108 })); return s; })(),
  ({ statePath, reload }) => {
    // close at 129.6 USD → 120 EUR ; realized = +1 * 2 * (120-100) = 40
    upsert(filledRec('cid_fs03', { symbol: 'AMAT', side: 'long', action: 'close', qty: 2, px: 129.6 }));
    const sum = syncFillsToPortfolio({ run_id: 'run_fs' });
    const s = reload();
    check('FS-03',
      sum.booked_close === 1 && s.open_positions.length === 0 &&
      near(s.realized_pnl, 40) && s.closed_positions_summary.count === 1 &&
      s.closed_positions_summary.wins === 1,
      'long close → position removed, realized +40 EUR, summary win+1');
  });

// ─── FS-04: short close PnL sign correct (price falls → short profit) ──────────
withEnv('fs04', (() => { const s = initPortfolio(); s.open_positions.push(openPos({ symbol: 'TSLA', side: 'short', qty: 2, entryUsd: 129.6 })); return s; })(),
  ({ statePath, reload }) => {
    // short entry 120 EUR, close at 108 USD → 100 EUR ; realized = -1 * 2 * (100-120) = +40
    upsert(filledRec('cid_fs04', { symbol: 'TSLA', side: 'short', action: 'close', qty: 2, px: 108 }));
    const sum = syncFillsToPortfolio({ run_id: 'run_fs' });
    const s = reload();
    check('FS-04',
      sum.booked_close === 1 && s.open_positions.length === 0 && near(s.realized_pnl, 40),
      'short close (price down) → realized +40 EUR');
  });

// ─── FS-05: non-FILLED records are never booked ────────────────────────────────
withEnv('fs05', initPortfolio(), ({ statePath, reload }) => {
  upsert({ ...filledRec('cid_fs05a', { qty: 2 }), state: 'submitted', filled_qty: 0 });
  upsert({ ...filledRec('cid_fs05b', { qty: 2 }), state: 'partially_filled', filled_qty: 1, remaining_qty: 1 });
  upsert({ ...filledRec('cid_fs05c', { qty: 2 }), state: 'cancelled', filled_qty: 0 });
  const sum = syncFillsToPortfolio({ run_id: 'run_fs' });
  const s = reload();
  check('FS-05',
    sum.eligible === 0 && sum.booked_open === 0 && s.open_positions.length === 0,
    'submitted / partially_filled / cancelled → eligible=0, nothing booked');
});

// ─── FS-06: missing/invalid avg_fill_price → fail-closed skip, no mutation ─────
withEnv('fs06', initPortfolio(), ({ statePath, reload }) => {
  upsert({ ...filledRec('cid_fs06', { qty: 2 }), avg_fill_price: null });
  const sum = syncFillsToPortfolio({ run_id: 'run_fs' });
  const s = reload();
  check('FS-06',
    sum.skipped === 1 && sum.skips[0].reason === 'missing_or_invalid_fill_price' &&
    s.open_positions.length === 0,
    'null avg_fill_price → skip(missing_or_invalid_fill_price), no position');
});

// ─── FS-07: open when a position already exists → skip (no double-open) ─────────
withEnv('fs07', (() => { const s = initPortfolio(); s.open_positions.push(openPos({ symbol: 'AMAT', side: 'long', qty: 2 })); return s; })(),
  ({ statePath, reload }) => {
    upsert(filledRec('cid_fs07', { symbol: 'AMAT', side: 'long', action: 'open', qty: 2, px: 108 }));
    const sum = syncFillsToPortfolio({ run_id: 'run_fs' });
    const s = reload();
    check('FS-07',
      sum.booked_open === 0 && sum.skipped === 1 && sum.skips[0].reason === 'open_but_position_exists' &&
      s.open_positions.length === 1,
      'open with existing position → skip(open_but_position_exists), still 1 position');
  });

// ─── FS-08: close without an open position → skip ──────────────────────────────
withEnv('fs08', initPortfolio(), ({ statePath, reload }) => {
  upsert(filledRec('cid_fs08', { symbol: 'AMAT', side: 'long', action: 'close', qty: 2, px: 129.6 }));
  const sum = syncFillsToPortfolio({ run_id: 'run_fs' });
  const s = reload();
  check('FS-08',
    sum.booked_close === 0 && sum.skipped === 1 && sum.skips[0].reason === 'close_without_open_position' &&
    near(s.realized_pnl, 0),
    'close with no open position → skip(close_without_open_position), realized unchanged');
});

// ─── FS-09: close qty mismatch → fail-closed skip, no mutation ─────────────────
withEnv('fs09', (() => { const s = initPortfolio(); s.open_positions.push(openPos({ symbol: 'AMAT', side: 'long', qty: 2 })); return s; })(),
  ({ statePath, reload }) => {
    upsert(filledRec('cid_fs09', { symbol: 'AMAT', side: 'long', action: 'close', qty: 1, px: 129.6 }));
    const sum = syncFillsToPortfolio({ run_id: 'run_fs' });
    const s = reload();
    check('FS-09',
      sum.booked_close === 0 && sum.skipped === 1 && sum.skips[0].reason === 'close_qty_mismatch' &&
      s.open_positions.length === 1 && near(s.realized_pnl, 0),
      'close qty 1 vs open qty 2 → skip(close_qty_mismatch), position intact');
  });

// ─── FS-10: open then close across two passes → full round-trip consistency ────
withEnv('fs10', initPortfolio(), ({ statePath, reload }) => {
  upsert(filledRec('cid_fs10_o', { symbol: 'NVDA', side: 'long', action: 'open', qty: 2, px: 108 }));
  const s1 = syncFillsToPortfolio({ run_id: 'run_fs' });
  const afterOpen = reload();
  upsert(filledRec('cid_fs10_c', { symbol: 'NVDA', side: 'long', action: 'close', qty: 2, px: 129.6 }));
  const s2 = syncFillsToPortfolio({ run_id: 'run_fs' });
  const afterClose = reload();
  check('FS-10',
    s1.booked_open === 1 && afterOpen.open_positions.length === 1 &&
    s2.booked_close === 1 && afterClose.open_positions.length === 0 &&
    near(afterClose.realized_pnl, 40) && near(afterClose.cash, 2040) && near(afterClose.equity_nav, 2040),
    'open(pass1)+close(pass2) → flat book, realized +40, cash & NAV 2040');
});

// ─── FS-11: no eligible fills → state file is NOT rewritten (true no-op) ────────
withEnv('fs11', initPortfolio(), ({ statePath, reload }) => {
  const before = statSync(statePath).mtimeMs;
  const sum = syncFillsToPortfolio({ run_id: 'run_fs' });
  const after = statSync(statePath).mtimeMs;
  check('FS-11',
    sum.scanned === 0 && sum.booked_open === 0 && sum.booked_close === 0 && before === after,
    'empty store → nothing booked, state file untouched (mtime unchanged)');
});

// ─── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nFillSync (Unit 10.5): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
