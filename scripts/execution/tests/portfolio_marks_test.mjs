#!/usr/bin/env node
/**
 * Portfolio-Marks (Problem #2-Fix) — dedicated test cases (PM-01 … PM-07).
 *
 * node scripts/execution/tests/portfolio_marks_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 *
 * Isolation: engine tests use isolated temp state files via _setTestPaths.
 * No test reads or writes the live portfolio_state.json.
 *
 * EUR_USD_RATE = 1.08 → entry_price_usd 108 = entry_price_eur 100.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join }                     from 'path';
import { tmpdir }                   from 'os';

import {
  initPortfolio, loadOrInit,
  _setTestPaths, _clearTestPaths,
} from '../portfolio/portfolio_state.mjs';
import { runPortfolio } from '../portfolio/portfolio_engine.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const SCRATCH = join(tmpdir(), `pmarks_${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });

function withTestState(tcId, initialState, fn) {
  const statePath = join(SCRATCH, `state_${tcId}.json`);
  writeFileSync(statePath, JSON.stringify(initialState, null, 2) + '\n', 'utf8');
  _setTestPaths({
    state:   statePath,
    history: join(SCRATCH, `hist_${tcId}.jsonl`),
    ledger:  join(SCRATCH, `ledger_${tcId}.jsonl`),
  });
  try { return fn(statePath); } finally { _clearTestPaths(); }
}

function readTestState(tcId) {
  _setTestPaths({ state: join(SCRATCH, `state_${tcId}.json`) });
  try { return loadOrInit(); } finally { _clearTestPaths(); }
}

function makePosition(sym, overrides = {}) {
  return {
    symbol: sym, asset_type: 'stock', side: 'long',
    quantity: 1, notional_eur: 100,
    entry_price_usd: 108, entry_price_eur: 100,
    mark_price_usd: 108, mark_price_eur: 100,
    unrealized_pnl_eur: 0, stop_loss_pct: 8, leverage: 1,
    entry_timestamp: new Date().toISOString(),
    entry_run_id: 'run_test', strategy: 'test', thesis_status: 'active',
    ...overrides,
  };
}

function makeStateWith(positions) {
  const s = initPortfolio();
  s.open_positions = positions;
  s.cash = +(s.initial_capital - positions.reduce((a, p) => a + p.notional_eur, 0)).toFixed(4);
  return s;
}

const makeRun = (runId, cands = [], marks = undefined) => ({
  run_id: runId,
  run_at: new Date().toISOString(),
  long_candidates:  cands,
  short_candidates: [],
  ...(marks !== undefined ? { portfolio_marks: marks } : {}),
});

// ─── PM-01: Position ist Scan-Kandidat → Quelle scan_candidate ───────────────
// Kandidat 118.80 USD = 110 EUR → unrealized +10 EUR. mark_source=scan_candidate.

{
  withTestState('pm01', makeStateWith([makePosition('PM01')]), () => {
    runPortfolio(makeRun('t_pm01', [{ symbol: 'PM01', price_usd: 118.8 }]), [], { runId: 't_pm01' });
  });
  const st  = readTestState('pm01');
  const pos = st.open_positions.find(p => p.symbol === 'PM01');
  check('PM-01',
    pos
    && pos.mark_price_usd === 118.8
    && pos.mark_source === 'scan_candidate'
    && pos.mark_status === undefined
    && Math.abs(pos.unrealized_pnl_eur - 10) < 0.01
    && pos.mark_updated_at != null,
    'Kandidaten-Mark gesetzt, mark_source=scan_candidate, unrealized +10 EUR');
}

// ─── PM-02: Kein Kandidat, aber portfolio_marks (stocks_cache) → Mark gesetzt ─

{
  withTestState('pm02', makeStateWith([makePosition('PM02')]), () => {
    runPortfolio(makeRun('t_pm02', [], {
      PM02: { available: true, price_usd: 118.8, source: 'stocks_cache', fetched_at: new Date().toISOString() },
    }), [], { runId: 't_pm02' });
  });
  const st  = readTestState('pm02');
  const pos = st.open_positions.find(p => p.symbol === 'PM02');
  check('PM-02',
    pos
    && pos.mark_price_usd === 118.8
    && pos.mark_source === 'stocks_cache'
    && pos.mark_status === undefined
    && Math.abs(pos.unrealized_pnl_eur - 10) < 0.01,
    'portfolio_mark aus stocks_cache greift, Position nicht mehr blind');
}

// ─── PM-03: Stop-Loss feuert über portfolio_marks-Preis ──────────────────────
// Mark 97.20 USD = 90 EUR → −10% < −8% SL → stop_loss_hit + Post-SL-Block.

{
  const summary = withTestState('pm03', makeStateWith([makePosition('PM03')]), () =>
    runPortfolio(makeRun('t_pm03', [], {
      PM03: { available: true, price_usd: 97.2, source: 'stocks_cache', fetched_at: new Date().toISOString() },
    }), [], { runId: 't_pm03' })
  );
  const st = readTestState('pm03');
  check('PM-03',
    summary.closed_this_run.length === 1
    && summary.closed_this_run[0].symbol === 'PM03'
    && summary.closed_this_run[0].reason === 'stop_loss_hit'
    && st.open_positions.length === 0
    && Math.abs(st.realized_pnl - (-10)) < 0.01
    && (st.blocked_symbols ?? []).some(b => b.symbol === 'PM03' && b.side === 'long'),
    'SL-Pfad nicht mehr blind: stop_loss_hit über portfolio_mark, Post-SL-Block gesetzt');
}

// ─── PM-04: Symbol nirgends auflösbar → mark_failed, Position bleibt offen ───

{
  const summary = withTestState('pm04', makeStateWith([makePosition('PM04')]), () =>
    runPortfolio(makeRun('t_pm04', [], {
      PM04: { available: false, reason: 'no_price_source' },
    }), [], { runId: 't_pm04' })
  );
  const st  = readTestState('pm04');
  const pos = st.open_positions.find(p => p.symbol === 'PM04');
  const um  = summary.unmatched_positions.find(u => u.symbol === 'PM04');
  check('PM-04',
    pos
    && pos.mark_status === 'mark_failed'
    && pos.mark_price_usd === 108            // alter Mark bleibt erhalten
    && um && um.reason === 'no_price_source'
    && summary.closed_this_run.length === 0,
    'Explizites mark_failed mit reason, Position offen, kein Crash');
}

// ─── PM-05: Legacy-Run ohne portfolio_marks-Feld → missing_from_scan ─────────
// Backward-Compat: alte Run-Logs dürfen das Verhalten nicht ändern.

{
  const summary = withTestState('pm05', makeStateWith([makePosition('PM05')]), () =>
    runPortfolio(makeRun('t_pm05', []), [], { runId: 't_pm05' })
  );
  const st  = readTestState('pm05');
  const pos = st.open_positions.find(p => p.symbol === 'PM05');
  const um  = summary.unmatched_positions.find(u => u.symbol === 'PM05');
  check('PM-05',
    pos
    && pos.mark_status === 'missing_from_scan'
    && um && um.reason === 'no_marks_data',
    'Legacy-Run-Log ohne portfolio_marks → missing_from_scan wie bisher');
}

// ─── PM-06: Kandidaten-Vorrang — portfolio_mark überschreibt NIE ──────────────

{
  withTestState('pm06', makeStateWith([makePosition('PM06')]), () => {
    runPortfolio(makeRun('t_pm06',
      [{ symbol: 'PM06', price_usd: 118.8 }],
      { PM06: { available: true, price_usd: 50, source: 'stocks_cache', fetched_at: new Date().toISOString() } },
    ), [], { runId: 't_pm06' });
  });
  const st  = readTestState('pm06');
  const pos = st.open_positions.find(p => p.symbol === 'PM06');
  check('PM-06',
    pos
    && pos.mark_price_usd === 118.8
    && pos.mark_source === 'scan_candidate',
    'Kandidatenpreis gewinnt gegen abweichenden portfolio_mark (Priorität)');
}

// ─── PM-07: Stale-Mark-Eskalation — Mark > 24h alt → position_mark_stale ─────

{
  const staleIso = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return origWrite(chunk, ...rest); };
  try {
    withTestState('pm07', makeStateWith([makePosition('PM07', { mark_updated_at: staleIso })]), () => {
      runPortfolio(makeRun('t_pm07', [], {
        PM07: { available: false, reason: 'mexc_ticker_failed: timeout' },
      }), [], { runId: 't_pm07' });
    });
  } finally {
    process.stderr.write = origWrite;
  }
  const st  = readTestState('pm07');
  const pos = st.open_positions.find(p => p.symbol === 'PM07');
  check('PM-07',
    pos
    && pos.mark_status === 'mark_failed'
    && captured.some(l => l.includes('position_mark_stale')),
    'Mark 48h alt + erneuter Fehlschlag → position_mark_stale-Warnung emittiert');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nportfolio_marks_test: ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed > 0 ? 1 : 0);
