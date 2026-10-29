#!/usr/bin/env node
/**
 * fib_levels.mjs — Fibonacci Retracement Levels (Version 1)
 *
 * [V1-VEREINFACHUNG-1] Swing-Berechnung via Close-Preise, nicht via Candle-Wicks.
 *   Konsequenz: Level leicht zu eng; Extrema bei volatilen Assets unterschätzt.
 *
 * [V1-VEREINFACHUNG-2] Keine Swing-Point-Erkennung (kein HH/LL-Algorithmus).
 *   Konsequenz: Swing-Fenster ist zeitbasiert (lookback Tage), nicht struktur-basiert.
 *
 * [V1-VEREINFACHUNG-3] Fixes Lookback-Fenster (Default 20 Tage), nicht adaptiv.
 *   Konsequenz: Kurze Trends oder lange Konsolidierungen können Level verzerren.
 *
 * Fib=ja gilt, wenn der currentPrice innerhalb tolerance_pct% eines der Level
 * 38.2% / 50.0% / 61.8% liegt — alle drei Level sind gleichwertig (V1-Design).
 *
 * Usage (module):
 *   import { computeFibLevels } from './fib_levels.mjs'
 *
 * Usage (tests):
 *   node fib_levels.mjs --test
 */

import { fileURLToPath } from 'url';

const DEFAULT_LOOKBACK      = 20;
const DEFAULT_TOLERANCE_PCT = 2.0;

const FIB_RATIOS = [
  { name: '38.2%', ratio: 0.382 },
  { name: '50.0%', ratio: 0.500 },
  { name: '61.8%', ratio: 0.618 },
];

/**
 * computeFibLevels — berechnet Fibonacci-Retracement-Level für einen Kandidaten.
 *
 * @param {{ closes: number[], direction: 'LONG'|'SHORT', currentPrice: number,
 *            lookback?: number, tolerance_pct?: number }} opts
 * @returns {{ available: boolean, ... }}
 */
export function computeFibLevels({ closes, direction, currentPrice, lookback = DEFAULT_LOOKBACK, tolerance_pct = DEFAULT_TOLERANCE_PCT }) {
  if (!Array.isArray(closes) || closes.length < lookback) {
    return { available: false, reason: 'insufficient_data' };
  }

  const window     = closes.slice(-lookback);
  const swing_high = Math.max(...window);
  const swing_low  = Math.min(...window);
  const range      = swing_high - swing_low;

  if (range < 1e-8) {
    return { available: false, reason: 'flat_market' };
  }

  // LONG: Retracement-Support (Preis zieht sich vom Hoch zurück → Kaufzone)
  // SHORT: Retracement-Widerstand (Preis bounct vom Tief nach oben → Shortzone)
  const calcLevel = (ratio) =>
    direction === 'LONG'
      ? swing_high - ratio * range
      : swing_low  + ratio * range;

  const levels = FIB_RATIOS.map(({ name, ratio }) => {
    const price   = calcLevel(ratio);
    const dist_pct = Math.abs(currentPrice - price) / price * 100;
    return { name, price, dist_pct };
  });

  const nearest = levels.reduce((a, b) => a.dist_pct <= b.dist_pct ? a : b);
  const in_zone = nearest.dist_pct <= tolerance_pct;

  const zone_summary = in_zone
    ? `${nearest.name} Fib (${nearest.dist_pct.toFixed(1)}%)`
    : `off-zone (nearest: ${nearest.name} ${nearest.dist_pct.toFixed(1)}%)`;

  return {
    available:           true,
    direction,
    swing_high,
    swing_low,
    range:               +range.toFixed(8),
    lookback,
    levels: {
      fib_382: +levels[0].price.toFixed(8),
      fib_500: +levels[1].price.toFixed(8),
      fib_618: +levels[2].price.toFixed(8),
    },
    current_price:       currentPrice,
    nearest_level_name:  nearest.name,
    nearest_level_price: +nearest.price.toFixed(8),
    dist_pct:            +nearest.dist_pct.toFixed(4),
    in_zone,
    zone_summary,
    tolerance_pct,
  };
}

// ─── Eingebettete Tests (node fib_levels.mjs --test) ─────────────────────────

const CLOSES_A = [
  100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
  110, 115, 120, 125, 130, 135, 140, 145, 143, 141,
];
// swing_high=145, swing_low=100, range=45
// LONG levels:  38.2%=127.81, 50.0%=122.50, 61.8%=117.19
// SHORT levels: 38.2%=117.19, 50.0%=122.50, 61.8%=127.81

function assert(label, condition, detail = '') {
  if (!condition) {
    process.stderr.write(`FAIL: ${label}${detail ? ' — ' + detail : ''}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS: ${label}\n`);
  }
}

function runTests() {
  // Test 1 — LONG, 38.2%-Treffer (exakt)
  {
    const r = computeFibLevels({ closes: CLOSES_A, direction: 'LONG', currentPrice: 127.81 });
    assert('T1 LONG 38.2% hit: available', r.available === true);
    assert('T1 LONG 38.2% hit: nearest_level_name', r.nearest_level_name === '38.2%', `got ${r.nearest_level_name}`);
    assert('T1 LONG 38.2% hit: in_zone', r.in_zone === true, `dist_pct=${r.dist_pct}`);
    assert('T1 LONG 38.2% hit: dist_pct < 0.01%', r.dist_pct < 0.01, `got ${r.dist_pct}`);
  }

  // Test 2 — SHORT, 61.8%-Treffer (exakt)
  {
    const r = computeFibLevels({ closes: CLOSES_A, direction: 'SHORT', currentPrice: 127.81 });
    assert('T2 SHORT 61.8% hit: available', r.available === true);
    assert('T2 SHORT 61.8% hit: nearest_level_name', r.nearest_level_name === '61.8%', `got ${r.nearest_level_name}`);
    assert('T2 SHORT 61.8% hit: in_zone', r.in_zone === true, `dist_pct=${r.dist_pct}`);
    assert('T2 SHORT 61.8% hit: dist_pct < 0.01%', r.dist_pct < 0.01, `got ${r.dist_pct}`);
  }

  // Test 3 — LONG, 50%-Treffer (exakt)
  {
    const r = computeFibLevels({ closes: CLOSES_A, direction: 'LONG', currentPrice: 122.50 });
    assert('T3 LONG 50.0% hit: available', r.available === true);
    assert('T3 LONG 50.0% hit: nearest_level_name', r.nearest_level_name === '50.0%', `got ${r.nearest_level_name}`);
    assert('T3 LONG 50.0% hit: in_zone', r.in_zone === true, `dist_pct=${r.dist_pct}`);
    assert('T3 LONG 50.0% hit: dist_pct < 0.01%', r.dist_pct < 0.01, `got ${r.dist_pct}`);
  }

  // Test 4 — LONG, off-zone (kein Level in Reichweite)
  {
    // currentPrice=110: nearest=61.8%(117.19), dist=|110-117.19|/117.19*100=6.14%
    const r = computeFibLevels({ closes: CLOSES_A, direction: 'LONG', currentPrice: 110 });
    assert('T4 LONG off-zone: available', r.available === true);
    assert('T4 LONG off-zone: in_zone=false', r.in_zone === false, `dist_pct=${r.dist_pct}`);
    assert('T4 LONG off-zone: nearest=61.8%', r.nearest_level_name === '61.8%', `got ${r.nearest_level_name}`);
    assert('T4 LONG off-zone: dist > 2%', r.dist_pct > 2.0, `got ${r.dist_pct}`);
  }

  // Test 5 — insufficient_data
  {
    const r = computeFibLevels({ closes: [100, 101, 102], direction: 'LONG', currentPrice: 101 });
    assert('T5 insufficient_data: available=false', r.available === false);
    assert('T5 insufficient_data: reason', r.reason === 'insufficient_data', `got ${r.reason}`);
  }

  // Test 6 — flat_market
  {
    const r = computeFibLevels({ closes: Array(20).fill(100), direction: 'LONG', currentPrice: 100 });
    assert('T6 flat_market: available=false', r.available === false);
    assert('T6 flat_market: reason', r.reason === 'flat_market', `got ${r.reason}`);
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv.includes('--test')) {
    runTests();
  } else {
    const arg = process.argv[2];
    if (!arg) {
      process.stderr.write('Usage: node fib_levels.mjs \'{"closes":[...],"direction":"LONG","currentPrice":127.81}\'\n');
      process.exit(1);
    }
    try {
      const input  = JSON.parse(arg);
      const result = computeFibLevels(input);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (e) {
      process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
      process.exit(1);
    }
  }
}
