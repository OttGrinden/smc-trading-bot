/**
 * technical_scoring.mjs — Pure scoring functions, importable for tests.
 *
 * Exports: computeTStark, computeScoreBounds, SCORE_LEVERAGE_MAP
 * Used by: research_run.mjs, t_stark_test.mjs
 */

// SL-Regel: leverage × sl_pct ≈ 20% (konstante Collateral-Risikoexponierung)
export const SCORE_LEVERAGE_MAP = [
  { score: 10, leverage: 10, sl_pct: 2.0 },
  { score:  9, leverage:  8, sl_pct: 2.5 },
  { score:  8, leverage:  6, sl_pct: 3.3 },
];

/**
 * T_stark: Multi-Timeframe-Alignment ohne Katalysator.
 * Pflicht: RSI✓ Daily (≤40 LONG / ≥60 SHORT). Dann +1 je: W aligned, M aligned, Fib in_zone.
 * T_stark = true wenn RSI✓ + mindestens 2 weitere Signale (score ≥ 3 von max 4).
 */
export function computeTStark(technical, direction) {
  const empty = { t_stark: false, t_stark_score: 0, t_stark_signals: [] };
  if (!technical?.available || technical.rsi == null) return empty;

  const rsi  = technical.rsi;
  const rsiW = technical.rsi_weekly;
  const rsiM = technical.rsi_monthly;

  const rsiDOk = direction === 'LONG' ? rsi <= 40 : rsi >= 60;
  if (!rsiDOk) return empty;

  const signals = ['rsi_d'];
  if (rsiW != null && (direction === 'LONG' ? rsiW <= 50 : rsiW >= 50)) signals.push('rsi_w');
  if (rsiM != null && (direction === 'LONG' ? rsiM <= 50 : rsiM >= 50)) signals.push('rsi_m');
  if (technical.fib?.in_zone === true) signals.push('fib');

  return { t_stark: signals.length >= 3, t_stark_score: signals.length, t_stark_signals: signals };
}

/**
 * Score-Bounds: maschinell, ohne K.
 * floor   = minimum erreichbarer Score; T_stark=ja → floor=8 auch ohne K
 * ceiling = erreichbares Maximum wenn K=ja
 */
export function computeScoreBounds(riskLevel, technical, direction) {
  const T      = technical?.available === true && technical.rsi != null;
  const rsi    = technical?.rsi ?? null;
  const RSI_ok = T && (
    (direction === 'LONG'  && rsi <= 40) ||
    (direction === 'SHORT' && rsi >= 60)
  );
  const FIB_ok  = technical?.fib?.in_zone === true;
  const T_STARK = technical?.t_stark === true;

  let floor;
  if      (riskLevel === 'EXTREME') floor = 1;
  else if (riskLevel === 'HIGH')    floor = 2;
  else if (riskLevel === 'MEDIUM')  floor = 4;
  else                              floor = T_STARK ? 8 : 7;

  let ceiling;
  if      (riskLevel === 'EXTREME') ceiling = 1;
  else if (riskLevel === 'HIGH')    ceiling = 3;
  else if (riskLevel === 'MEDIUM')  ceiling = T ? 6 : 5;
  else {
    if (!RSI_ok)      ceiling = 8;
    else if (!FIB_ok) ceiling = 9;
    else              ceiling = 10;
  }

  const tier = SCORE_LEVERAGE_MAP.find(t => t.score === ceiling);
  return {
    floor,
    ceiling,
    t_stark: T_STARK,
    leverage_at_ceiling: tier?.leverage ?? 1,
    sl_pct_at_ceiling:   tier?.sl_pct  ?? null,
  };
}
