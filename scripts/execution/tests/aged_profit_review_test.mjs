#!/usr/bin/env node
/**
 * aged_profit_review_test — 6 cases for the aged-profit-review flag.
 *
 * node scripts/execution/tests/aged_profit_review_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 *
 * What is tested:
 *   APR-01  Criteria met (>= MIN_DAYS, >= MIN_PNL_PCT, not in candidates)
 *           → approval_status = 'aged_profit_review', days_open set
 *   APR-02  Too young (< MIN_DAYS) → not_in_top_candidates, no aged flag
 *   APR-03  Old enough but gain < MIN_PNL_PCT → not_in_top_candidates, no aged flag
 *   APR-04  Criteria met but position IS in same-side candidates → held normally,
 *           aged flag NOT set (sameSide branch wins, no approval_status mutation)
 *   APR-05  APR-01 scenario: position stays in survivors — no auto-close
 *   APR-06  approval_status = 'aged_profit_review' on an existing position does not
 *           block a new allocation for a different symbol
 *
 * EUR_USD_RATE = 1.08 (fixed placeholder, portfolio_state.mjs).
 * entry_price_usd=108 → entry_price_eur=100.
 * scan price 118.8   → mark_price_eur=110  → +10% on notional 100 (APR-01/02/04/05)
 * scan price 112.32  → mark_price_eur=104  →  +4% on notional 100 (APR-03)
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join }                     from 'path';
import { tmpdir }                   from 'os';

import {
  initPortfolio,
  _setTestPaths, _clearTestPaths,
} from '../portfolio/portfolio_state.mjs';
import { allocate, ALLOC_RULES } from '../portfolio/allocation_engine.mjs';
import { runPortfolio }          from '../portfolio/portfolio_engine.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────

const RESULTS = [];

function pass(id, msg) {
  RESULTS.push({ id, status: 'PASS', msg });
  process.stderr.write(`  PASS  ${id}: ${msg}\n`);
}
function fail(id, msg) {
  RESULTS.push({ id, status: 'FAIL', msg });
  process.stderr.write(`  FAIL  ${id}: ${msg} [ASSERTION FAILED]\n`);
}
function check(id, cond, msg) {
  if (cond) pass(id, msg); else fail(id, msg);
}

// ─── Scratch helpers (same pattern as regression_smoke) ───────────────────────

const SCRATCH = join(tmpdir(), `apr_test_${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });

function withTestState(tcId, initialState, fn) {
  const statePath  = join(SCRATCH, `state_${tcId}.json`);
  const histPath   = join(SCRATCH, `hist_${tcId}.jsonl`);
  const ledgerPath = join(SCRATCH, `ledger_${tcId}.jsonl`);
  writeFileSync(statePath, JSON.stringify(initialState, null, 2) + '\n', 'utf8');
  _setTestPaths({ state: statePath, history: histPath, ledger: ledgerPath });
  try {
    return fn();
  } finally {
    _clearTestPaths();
  }
}

function makeState(openPositions = []) {
  const s = initPortfolio();
  for (const p of openPositions) s.open_positions.push(p);
  const committed = openPositions.reduce((sum, p) => sum + (p.notional_eur ?? 0), 0);
  s.cash = +(s.initial_capital - committed).toFixed(4);
  return s;
}

/** Minimal open position. entry_price_usd=108 → entry_price_eur=100, quantity=1, notional=100 */
function makePos(overrides = {}) {
  return {
    symbol:                 'APRSYM',
    side:                   'long',
    asset_type:             'stock',
    quantity:               1.0,
    notional_eur:           100,
    entry_price_usd:        108,
    entry_price_eur:        100,
    mark_price_usd:         108,
    mark_price_eur:         100,
    unrealized_pnl_eur:     0,
    stop_loss_pct:          null,
    leverage:               1.0,
    entry_timestamp:        new Date().toISOString(),
    entry_run_id:           null,
    strategy:               'test',
    thesis:                 'test',
    decision_source:        {},
    k_at_entry:             null,
    catalyst_recognized_at: null,
    thesis_status:          'active',
    thesis_valid_until:     null,
    catalyst_event_date:    null,
    thesis_last_reviewed_at: null,
    ...overrides,
  };
}

/** ISO timestamp N calendar days in the past */
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/** Minimal run output: symbol with mark price, no decisions */
function scanWith(symbol, priceUsd) {
  return { long_candidates: [{ symbol, price_usd: priceUsd }], short_candidates: [] };
}

/** Minimal approved decision (for sameSide tests) */
function makeDecision(sym, side = 'long') {
  return {
    intent: {
      intent_id: `intent_${sym}_${side}`, symbol: sym, side,
      asset_type: 'stock', price_usd: 118.8,
      confidence_score_normalized: 0.6, technical_alignment: 'confirmed',
      technical: { age_minutes: 5 },
      risk: { stop_loss_pct: 5, suggested_position_pct: 3 },
      signal_timestamp: new Date().toISOString(),
      intent_created_at: new Date().toISOString(),
    },
    decision: { execution_ready: true, blocked_reasons: [] },
  };
}

// ─── APR-01: criteria met → aged_profit_review ───────────────────────────────
// age = 22 days (>= 21), pnl = +10% on notional, not in candidates

{
  const pos = makePos({
    symbol:          'APR01',
    entry_timestamp: daysAgo(22),
    // mark will be set by engine from scan price below
  });
  const state = makeState([pos]);

  const result = withTestState('apr01', state, () =>
    runPortfolio(scanWith('APR01', 118.8), [], { runId: 'test_apr01' })
  );

  const outPos = result.open_positions.find(p => p.symbol === 'APR01');
  check('APR-01',
    outPos?.approval_status === 'aged_profit_review'
    && outPos?.days_open    === 22,
    `aged_profit_review set when age=22d, pnl≈+10% (approval_status=${outPos?.approval_status}, days_open=${outPos?.days_open})`);
}

// ─── APR-02: too young → not_in_top_candidates, no aged flag ─────────────────
// age = 20 days (< 21), pnl = +10%

{
  const pos = makePos({
    symbol:          'APR02',
    entry_timestamp: daysAgo(20),
  });
  const state = makeState([pos]);

  const result = withTestState('apr02', state, () =>
    runPortfolio(scanWith('APR02', 118.8), [], { runId: 'test_apr02' })
  );

  const outPos = result.open_positions.find(p => p.symbol === 'APR02');
  check('APR-02',
    outPos?.approval_status === 'not_in_top_candidates',
    `no aged flag when age=20d < MIN_DAYS=${ALLOC_RULES.AGED_PROFIT_REVIEW_MIN_DAYS} (approval_status=${outPos?.approval_status})`);
}

// ─── APR-03: old enough but gain < MIN_PNL_PCT → not_in_top_candidates ───────
// age = 22 days, pnl = +4% (< 5%)
// scan price 112.32 → mark_price_eur=104 → unrealized=+4 on notional 100

{
  const pos = makePos({
    symbol:          'APR03',
    entry_timestamp: daysAgo(22),
  });
  const state = makeState([pos]);

  const result = withTestState('apr03', state, () =>
    runPortfolio(scanWith('APR03', 112.32), [], { runId: 'test_apr03' })
  );

  const outPos = result.open_positions.find(p => p.symbol === 'APR03');
  check('APR-03',
    outPos?.approval_status === 'not_in_top_candidates',
    `no aged flag when pnl≈+4% < MIN_PNL_PCT=${ALLOC_RULES.AGED_PROFIT_REVIEW_MIN_PNL_PCT}% (approval_status=${outPos?.approval_status})`);
}

// ─── APR-04: criteria met but position is in same-side candidates → no aged flag
// age = 22 days, pnl = +10%, but a matching decision is passed → sameSide=true
// The sameSide branch holds normally; aged flag must NOT be set.

{
  const pos = makePos({
    symbol:          'APR04',
    entry_timestamp: daysAgo(22),
  });
  const state = makeState([pos]);

  const result = withTestState('apr04', state, () =>
    runPortfolio(scanWith('APR04', 118.8), [makeDecision('APR04', 'long')], { runId: 'test_apr04' })
  );

  const outPos = result.open_positions.find(p => p.symbol === 'APR04');
  const closed = result.closed_this_run.some(c => c.symbol === 'APR04');
  check('APR-04',
    outPos != null
    && outPos.approval_status !== 'aged_profit_review'
    && !closed,
    `sameSide branch wins: no aged flag even when age=22d, pnl≈+10% (approval_status=${outPos?.approval_status})`);
}

// ─── APR-05: aged_profit_review is review-only — no auto-close ───────────────
// Same setup as APR-01; verify position remains in open_positions.

{
  const pos = makePos({
    symbol:          'APR05',
    entry_timestamp: daysAgo(22),
  });
  const state = makeState([pos]);

  const result = withTestState('apr05', state, () =>
    runPortfolio(scanWith('APR05', 118.8), [], { runId: 'test_apr05' })
  );

  const stillOpen = result.open_positions.some(p => p.symbol === 'APR05');
  const closed    = result.closed_this_run.some(c => c.symbol === 'APR05');
  check('APR-05',
    stillOpen && !closed,
    'aged_profit_review does not auto-close — position remains open');
}

// ─── APR-06: aged_profit_review on existing position does not affect allocator ─
// Pre-set approval_status='aged_profit_review' on an open position,
// then call allocate() with a new candidate for a different symbol.
// The existing position's approval_status must be ignored by the allocator.

{
  const existingPos = makePos({
    symbol:          'APR06HELD',
    approval_status: 'aged_profit_review',  // pre-set as if set by a previous run
    notional_eur:    100,
    stop_loss_pct:   5,
    sector:          null,
  });
  const state = makeState([existingPos]);   // cash = 1900, one open position

  const candidate = {
    intent: {
      intent_id: 'intent_APR06NEW_long', symbol: 'APR06NEW', side: 'long',
      asset_type: 'stock', price_usd: 108,
      confidence_score_normalized: 0.6, technical_alignment: 'confirmed',
      technical: { age_minutes: 5 },
      risk: { stop_loss_pct: 5, suggested_position_pct: 3 },
      signal_timestamp: new Date().toISOString(),
      intent_created_at: new Date().toISOString(),
    },
    decision: { execution_ready: true, blocked_reasons: [] },
  };

  const { newPositions, skipped } = allocate(state, [candidate], { runId: 't_apr06' });

  check('APR-06',
    newPositions.some(p => p.symbol === 'APR06NEW')
    && !skipped.some(s => s.symbol === 'APR06NEW'),
    'approval_status=aged_profit_review on existing pos does not block new allocation');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const passed = RESULTS.filter(r => r.status === 'PASS').length;
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\naged_profit_review_test: ${passed}/${RESULTS.length} PASS\n`);
process.exit(failed > 0 ? 1 : 0);
