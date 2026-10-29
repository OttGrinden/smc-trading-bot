#!/usr/bin/env node
/**
 * t_stark_test.mjs — Unit tests for computeTStark + computeScoreBounds
 *
 * node scripts/execution/tests/t_stark_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { computeTStark, computeScoreBounds } from '../../technical_scoring.mjs';

const results = [];
function check(id, cond, msg) {
  const status = cond ? 'PASS' : 'FAIL';
  results.push({ id, status });
  process.stderr.write(`  ${status}  ${id}: ${msg}\n`);
}

// ─── computeTStark ────────────────────────────────────────────────────────────

// TS-01: RSI✓ Daily not met → always false
{
  const r = computeTStark({ available: true, rsi: 55, rsi_weekly: 45, rsi_monthly: 44, fib: { in_zone: true } }, 'LONG');
  check('TS-01', !r.t_stark && r.t_stark_score === 0, 'LONG RSI D:55 (>40) → T_stark=false');
}

// TS-02: RSI✓ only, no additional signals → false
{
  const r = computeTStark({ available: true, rsi: 38, rsi_weekly: 55, rsi_monthly: 58, fib: { in_zone: false } }, 'LONG');
  check('TS-02', !r.t_stark && r.t_stark_score === 1, 'LONG RSI D:38, W:55, M:58, Fib=false → score=1, T_stark=false');
}

// TS-03: RSI✓ + W aligned only → false (only 2 signals)
{
  const r = computeTStark({ available: true, rsi: 36, rsi_weekly: 44, rsi_monthly: 53, fib: { in_zone: false } }, 'LONG');
  check('TS-03', !r.t_stark && r.t_stark_score === 2, 'LONG RSI D:36 W:44 M:53(>50) Fib=false → score=2, T_stark=false');
}

// TS-04: RSI✓ + W + M → true (3 signals)
{
  const r = computeTStark({ available: true, rsi: 35, rsi_weekly: 44, rsi_monthly: 47, fib: { in_zone: false } }, 'LONG');
  check('TS-04', r.t_stark && r.t_stark_score === 3 && r.t_stark_signals.includes('rsi_w') && r.t_stark_signals.includes('rsi_m'), 'LONG D:35 W:44 M:47 → T_stark=true (rsi_d+rsi_w+rsi_m)');
}

// TS-05: RSI✓ + W + Fib → true (3 signals, no M)
{
  const r = computeTStark({ available: true, rsi: 39, rsi_weekly: 48, rsi_monthly: 52, fib: { in_zone: true } }, 'LONG');
  check('TS-05', r.t_stark && r.t_stark_signals.includes('fib') && !r.t_stark_signals.includes('rsi_m'), 'LONG D:39 W:48 M:52(>50) Fib=true → T_stark=true (rsi_d+rsi_w+fib)');
}

// TS-06: All 4 signals → score=4
{
  const r = computeTStark({ available: true, rsi: 33, rsi_weekly: 41, rsi_monthly: 46, fib: { in_zone: true } }, 'LONG');
  check('TS-06', r.t_stark && r.t_stark_score === 4, 'LONG all 4 signals → T_stark=true, score=4');
}

// TS-07: SHORT RSI✓ + W + M → true
{
  const r = computeTStark({ available: true, rsi: 68, rsi_weekly: 63, rsi_monthly: 55, fib: { in_zone: false } }, 'SHORT');
  check('TS-07', r.t_stark && r.t_stark_signals.includes('rsi_d') && r.t_stark_signals.includes('rsi_w') && r.t_stark_signals.includes('rsi_m'), 'SHORT D:68 W:63 M:55 → T_stark=true');
}

// TS-08: SHORT RSI✓ not met (D:58 < 60) → false
{
  const r = computeTStark({ available: true, rsi: 58, rsi_weekly: 62, rsi_monthly: 57, fib: { in_zone: true } }, 'SHORT');
  check('TS-08', !r.t_stark, 'SHORT D:58 (<60) → T_stark=false despite other signals');
}

// TS-09: technical.available=false → always false
{
  const r = computeTStark({ available: false }, 'LONG');
  check('TS-09', !r.t_stark && r.t_stark_score === 0, 'technical unavailable → T_stark=false');
}

// TS-10: PATH SHORT today: D:69.3 W:66.4 M:53.0, fib off-zone
{
  const r = computeTStark({ available: true, rsi: 69.3, rsi_weekly: 66.4, rsi_monthly: 53.0, fib: { in_zone: false } }, 'SHORT');
  check('TS-10', r.t_stark && r.t_stark_score === 3, 'PATH SHORT live data → T_stark=true');
}

// ─── computeScoreBounds ───────────────────────────────────────────────────────

// SB-01: R=LOW, T_stark=false → floor=7
{
  const tech = { available: true, rsi: 55, t_stark: false, fib: { in_zone: false } };
  const r = computeScoreBounds('LOW', tech, 'LONG');
  check('SB-01', r.floor === 7, 'R=LOW, T_stark=false → floor=7');
}

// SB-02: R=LOW, T_stark=true → floor=8
{
  const tech = { available: true, rsi: 35, t_stark: true, fib: { in_zone: false } };
  const r = computeScoreBounds('LOW', tech, 'LONG');
  check('SB-02', r.floor === 8 && r.t_stark === true, 'R=LOW, T_stark=true → floor=8');
}

// SB-03: R=LOW, RSI✓=ja (LONG≤40), Fib=false → ceiling=9
{
  const tech = { available: true, rsi: 38, t_stark: true, fib: { in_zone: false } };
  const r = computeScoreBounds('LOW', tech, 'LONG');
  check('SB-03', r.ceiling === 9 && r.leverage_at_ceiling === 8, 'R=LOW RSI✓ Fib=false → ceiling=9, leverage=8x');
}

// SB-04: R=LOW, RSI✓=ja, Fib=true → ceiling=10
{
  const tech = { available: true, rsi: 38, t_stark: true, fib: { in_zone: true } };
  const r = computeScoreBounds('LOW', tech, 'LONG');
  check('SB-04', r.ceiling === 10, 'R=LOW RSI✓ Fib=true → ceiling=10');
}

// SB-05: R=MEDIUM → floor=4 regardless of T_stark
{
  const tech = { available: true, rsi: 35, t_stark: true, fib: { in_zone: true } };
  const r = computeScoreBounds('MEDIUM', tech, 'LONG');
  check('SB-05', r.floor === 4, 'R=MEDIUM ignores T_stark for floor');
}

// SB-06: T_stark=true + R=LOW + SHORT RSI✓ → floor=8, ceiling=9
{
  const tech = { available: true, rsi: 68, t_stark: true, fib: { in_zone: false } };
  const r = computeScoreBounds('LOW', tech, 'SHORT');
  check('SB-06', r.floor === 8 && r.ceiling === 9, 'SHORT T_stark → floor=8 ceiling=9');
}

// ─── Results ─────────────────────────────────────────────────────────────────

const failed = results.filter(r => r.status === 'FAIL');
process.stderr.write(`\n  ${results.length - failed.length}/${results.length} PASS\n`);
if (failed.length) {
  process.stderr.write(`  FAILED: ${failed.map(r => r.id).join(', ')}\n`);
  process.exit(1);
}
