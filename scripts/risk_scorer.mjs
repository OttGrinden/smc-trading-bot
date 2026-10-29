#!/usr/bin/env node
/**
 * Risk Scorer
 * Input:  single candidate object (from context_builder output)
 * Output: structured risk object — numeric scores, clear labels, no soft language
 *
 * Usage (CLI):    node risk_scorer.mjs '<json-string>'
 * Usage (module): import { assessRisk } from './risk_scorer.mjs'
 */

import { fileURLToPath } from 'url';

// --- Config — tune weights and thresholds here, not in logic ---------------

const WEIGHTS = { liquidity: 0.35, volatility: 0.35, category: 0.30 };

const LIQUIDITY_TIERS = [
  [500_000_000, 1],
  [50_000_000,  3],
  [5_000_000,   5],
  [1_000_000,   7],
  [0,           9],
];

const VOLATILITY_TIERS = [
  [20, 9],
  [10, 7],
  [5,  5],
  [2,  3],
  [0,  1],
];

// Ordered highest-first; score > threshold → that level
const RISK_LEVEL_THRESHOLDS = [
  [7.0, 'EXTREME'],
  [5.0, 'HIGH'],
  [3.0, 'MEDIUM'],
  [0,   'LOW'],
];

const POSITION_SIZE_PCT = { LOW: 5.0, MEDIUM: 3.0, HIGH: 1.0, EXTREME: 0.5 };

const STOP_LOSS_TIERS = [
  [10, 12],
  [5,   8],
  [2,   5],
  [0,   3],
];

// --- Scoring helpers -------------------------------------------------------

function tieredScore(value, tiers) {
  for (const [threshold, score] of tiers) {
    if (value >= threshold) return score;
  }
  return tiers.at(-1)[1];
}

function liquidityScore(volUsd) {
  if (!volUsd || volUsd <= 0) return 10;
  return tieredScore(volUsd, LIQUIDITY_TIERS);
}

function volatilityScore(absChangePct) {
  return tieredScore(absChangePct, VOLATILITY_TIERS);
}

function categoryScore(category, volUsd, isNotable) {
  if (category === 'Stock') {
    if (!volUsd || volUsd < 5_000_000)  return 6;  // small-cap
    if (volUsd < 500_000_000)           return 4;  // mid-cap
    return 2;                                       // large-cap
  }
  // Crypto
  if (!volUsd || volUsd < 1_000_000)   return 9;  // micro-cap
  if (isNotable && volUsd >= 100_000_000) return 2; // BTC/ETH/XRP class — institutional-grade
  if (isNotable)                        return 5;  // small notable
  return 7;                                        // altcoin
}

function compositeScore(l, v, c) {
  return +(l * WEIGHTS.liquidity + v * WEIGHTS.volatility + c * WEIGHTS.category).toFixed(2);
}

function riskLevel(comp) {
  for (const [threshold, label] of RISK_LEVEL_THRESHOLDS) {
    if (comp > threshold) return label;
  }
  return 'LOW';
}

function stopLossPct(absChangePct) {
  return tieredScore(absChangePct, STOP_LOSS_TIERS);
}

// --- Flag detection --------------------------------------------------------

function buildFlags(candidate) {
  const { category, sector, volume_usd: vol, change_pct, is_notable } = candidate;
  const absChg = Math.abs(change_pct ?? 0);
  const flags  = [];

  if (!vol || vol < 1_000_000)              flags.push('micro_cap_liquidity');
  if (absChg > 15)                           flags.push('extreme_single_day_move');
  else if (absChg > 8)                       flags.push('large_single_day_move');
  if (category !== 'Stock' && !is_notable)   flags.push('crypto_no_fundamental');
  if (category === 'Stock' && vol < 5_000_000) flags.push('low_volume_stock');
  if (sector === 'biotech')                  flags.push('biotech_binary_risk');
  if (sector === 'quantum_computing')        flags.push('quantum_speculative');

  return flags;
}

// --- Public API ------------------------------------------------------------

// RSI is intentionally excluded — score depends only on base candidate data
// so it remains deterministic and computable without TV access.
export function assessRisk(candidate) {
  const absChg  = Math.abs(candidate.change_pct  ?? 0);
  const volUsd  = candidate.volume_usd            ?? 0;
  const cat     = candidate.category              ?? 'Crypto';
  const notable = candidate.is_notable            ?? false;

  const l    = liquidityScore(volUsd);
  const v    = volatilityScore(absChg);
  const c    = categoryScore(cat, volUsd, notable);
  const comp = compositeScore(l, v, c);
  const level = riskLevel(comp);

  return {
    symbol:                 candidate.symbol,
    risk_scores:            { liquidity: l, volatility: v, category: c, composite: comp },
    risk_level:             level,
    suggested_position_pct: POSITION_SIZE_PCT[level],
    stop_loss_pct:          stopLossPct(absChg),
    flags:                  buildFlags(candidate),
    assessed_at:            new Date().toISOString(),
  };
}

// --- CLI mode (only when run directly) ------------------------------------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write('Usage: node risk_scorer.mjs \'<candidate-json>\'\n');
    process.exit(1);
  }
  try {
    const input  = JSON.parse(arg);
    const result = assessRisk(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(1);
  }
}
