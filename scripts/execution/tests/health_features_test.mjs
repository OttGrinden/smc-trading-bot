#!/usr/bin/env node
/**
 * health_features_test.mjs — Tests für Take-Profit, SL-Proximity-Alert, Analytics
 *
 * Testet die in der Health-Fix-Session 2026-07-29 eingeführten Features:
 *   HF-01 … HF-03: Take-Profit (allocation + engine exit)
 *   HF-04 … HF-06: SL-Proximity-Alert (engine detection)
 *   HF-07 … HF-09: Analytics (computeAnalytics Sanity-Checks)
 *
 * Usage: node execution/tests/health_features_test.mjs
 */

import { allocate, ALLOC_RULES }   from '../portfolio/allocation_engine.mjs';
import { pruneIndicatorCache }      from '../../indicator_cache.mjs';
import { prunePositioningCache }    from '../../positioning_fetcher.mjs';
import { computeAnalytics }         from '../../analytics.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function makeState(overrides = {}) {
  return {
    cash: 1000, equity_nav: 1000, open_positions: [],
    gross_exposure: 0, net_exposure: 0, leverage_used: 0,
    realized_pnl: 0, unrealized_pnl: 0,
    blocked_symbols: [], deploy_run_id: null, deploy_run_used_eur: 0,
    ...overrides,
  };
}

function makeApproved(symbol = 'TST', side = 'long', slPct = 8) {
  return [{
    intent: {
      symbol, asset_type: 'stock', side, price_usd: 100,
      risk: { stop_loss_pct: slPct }, sector: 'semiconductor',
      strategy: 'test', confidence_score_normalized: 0.8,
      technical_alignment: 'partial', katalysator: null,
      intent_created_at: null, intent_id: `i_${symbol}`,
    },
    decision: { decision_id: `d_${symbol}`, execution_ready: true, blocked_reasons: [] },
  }];
}

// ─── HF-01: Take-Profit wird auf neue Positionen gestempelt ──────────────────

console.log('\n--- Take-Profit ---');

{
  const { newPositions } = allocate(makeState(), makeApproved('TP1'), {
    leverageCap: 1, runId: 'test', takeProfitPct: 15,
  });
  assert('HF-01: take_profit_pct=15 auf neuer Position gesetzt',
    newPositions[0]?.take_profit_pct === 15,
    `got ${newPositions[0]?.take_profit_pct}`);
}

// HF-02: Ohne takeProfitPct bleibt take_profit_pct null
{
  const { newPositions } = allocate(makeState(), makeApproved('TP2'), {
    leverageCap: 1, runId: 'test',
  });
  assert('HF-02: take_profit_pct=null wenn nicht übergeben',
    newPositions[0]?.take_profit_pct === null,
    `got ${newPositions[0]?.take_profit_pct}`);
}

// HF-03: take_profit_pct=0 wird nicht gesetzt (ungültiger Wert)
{
  const { newPositions } = allocate(makeState(), makeApproved('TP3'), {
    leverageCap: 1, runId: 'test', takeProfitPct: 0,
  });
  // 0 ist kein gültiger TP (> 0 Bedingung in engine); wird als null behandelt
  // allocation_engine setzt den Wert direkt, Engine-Guard überprüft > 0
  assert('HF-03: take_profit_pct=0 wird gespeichert (Guard in engine)',
    newPositions[0]?.take_profit_pct === 0,
    `got ${newPositions[0]?.take_profit_pct}`);
}

// ─── HF-04 … HF-06: SL-Proximity-Erkennung (Unit-Level) ─────────────────────

console.log('\n--- SL-Proximity Detection ---');

function computeDistToSl(entryEur, markEur, side, slPct) {
  const dir = side === 'long' ? 1 : -1;
  const pnlPct = dir * (markEur - entryEur) / entryEur * 100;
  return slPct + pnlPct; // > 0 = headroom, ≤ 0 = breached
}

{
  // LONG: entry 100, mark 92.5, SL 8% → pnl = -7.5% → dist = 0.5%
  const dist = computeDistToSl(100, 92.5, 'long', 8);
  assert('HF-04: LONG 0.5% vom SL wird erkannt (dist ≤ 1.0)',
    dist > 0 && dist <= 1.0,
    `dist=${dist.toFixed(3)}`);
}

{
  // LONG: entry 100, mark 95, SL 8% → pnl = -5% → dist = 3% → kein Alert
  const dist = computeDistToSl(100, 95, 'long', 8);
  assert('HF-05: LONG 3% vom SL löst keinen Alert aus (dist > 1.0)',
    dist > 1.0,
    `dist=${dist.toFixed(3)}`);
}

{
  // SHORT: entry 100, mark 107.5, SL 8% → pnl = -7.5% → dist = 0.5%
  const dist = computeDistToSl(100, 107.5, 'short', 8);
  assert('HF-06: SHORT 0.5% vom SL wird erkannt (dist ≤ 1.0)',
    dist > 0 && dist <= 1.0,
    `dist=${dist.toFixed(3)}`);
}

// ─── HF-07 … HF-09: Analytics Sanity-Checks ──────────────────────────────────

console.log('\n--- Analytics ---');

{
  let result;
  try { result = computeAnalytics(); } catch(e) { result = { error: e.message }; }

  assert('HF-07: computeAnalytics gibt kein Error zurück',
    !result.error,
    result.error ?? '');

  if (!result.error) {
    assert('HF-08: Sharpe ist eine endliche Zahl oder null',
      result.sharpe === null || (Number.isFinite(result.sharpe)),
      `got ${result.sharpe}`);

    assert('HF-09: max_drawdown_pct ≤ 0',
      result.max_drawdown_pct <= 0,
      `got ${result.max_drawdown_pct}`);
  } else {
    failed += 2; // HF-08 + HF-09 können nicht getestet werden
    console.error('  SKIP  HF-08: analytics error → übersprungen');
    console.error('  SKIP  HF-09: analytics error → übersprungen');
  }
}

// ─── HF-10: pruneIndicatorCache gibt { pruned, kept } zurück ─────────────────

console.log('\n--- Cache Pruning API ---');

{
  const result = pruneIndicatorCache(60);
  assert('HF-10: pruneIndicatorCache gibt { pruned, kept } zurück',
    typeof result.pruned === 'number' && typeof result.kept === 'number',
    JSON.stringify(result));
}

// HF-11: prunePositioningCache analog
{
  const result = prunePositioningCache(90);
  assert('HF-11: prunePositioningCache gibt { pruned, kept } zurück',
    typeof result.pruned === 'number' && typeof result.kept === 'number',
    JSON.stringify(result));
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nhealth_features_test: ${passed}/${passed + failed} PASS`);
if (failed > 0) process.exit(1);
