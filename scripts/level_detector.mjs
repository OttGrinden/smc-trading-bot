#!/usr/bin/env node
/**
 * level_detector.mjs — Key-Level-Detektor für Intraday-Signale
 *
 * Liest intraday_cache.json und berechnet für jedes Symbol:
 * - Runde Zahlen (preisbasiertes Grid)
 * - 24h H/L
 * - Session H/L (aus Kerzen)
 * - VWAP
 * - Swing Highs / Swing Lows (lokale Extrema aus letzten 30 Kerzen)
 *
 * Schreibt: trading/cache/intraday_levels.json
 *
 * Usage:
 *   node level_detector.mjs                     # alle Symbole aus Cache
 *   node level_detector.mjs --symbols BTC,SNDK  # nur diese Symbole
 *   node level_detector.mjs --proximity 5       # nur Level <5% vom Preis entfernt (Standard: 8%)
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath }                           from 'url';
import { dirname, join, resolve }                  from 'path';

const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const CACHE_IN  = join(TRADING_DIR, 'cache', 'intraday_cache.json');
const CACHE_OUT = join(TRADING_DIR, 'cache', 'intraday_levels.json');

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const symIdx  = argv.indexOf('--symbols');
  const proxIdx = argv.indexOf('--proximity');
  return {
    symbols:   symIdx  !== -1 ? argv[symIdx  + 1]?.split(',').map(s => s.trim().toUpperCase()) : null,
    proximity: proxIdx !== -1 ? parseFloat(argv[proxIdx + 1]) : 8.0,
    quiet:     argv.includes('--quiet'),
  };
}

// ─── Runde-Zahlen-Grid bestimmen ─────────────────────────────────────────────

function getRoundGrids(price) {
  if (price >= 10_000) return [1000, 2500, 5000];
  if (price >= 1_000)  return [100, 250, 500, 1000];
  if (price >= 100)    return [10, 25, 50, 100];
  if (price >= 10)     return [1, 2.5, 5, 10];
  if (price >= 1)      return [0.1, 0.25, 0.5, 1];
  if (price >= 0.1)    return [0.01, 0.025, 0.05, 0.1];
  return [0.001, 0.0025, 0.005, 0.01];
}

function roundLevelsNear(price, proximityPct) {
  const maxDist = price * (proximityPct / 100);
  const grids   = getRoundGrids(price);
  const levels  = new Set();

  for (const g of grids) {
    // Nächstes rundes Level unten und oben
    const base = Math.floor(price / g) * g;
    for (let k = -3; k <= 3; k++) {
      const lvl = +(base + k * g).toPrecision(8);
      if (Math.abs(lvl - price) <= maxDist * 2 && lvl > 0) {
        levels.add(lvl);
      }
    }
  }
  return [...levels];
}

// ─── Swing Highs / Lows aus Kerzen ───────────────────────────────────────────
// Pivot-Methode: eine Kerze ist Swing-High, wenn ihr High > High der 2 Kerzen davor und danach

function detectSwings(candles, lookback = 2) {
  const n      = candles.length;
  const swings = [];
  // Nur letzte 30 Kerzen (2.5h auf 5min-Chart)
  const from   = Math.max(lookback, n - 30);

  for (let i = from; i < n - lookback; i++) {
    const c = candles[i];

    // Swing High
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) swings.push({ price: c.high, type: 'swing_high', time: c.time });

    // Swing Low
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) swings.push({ price: c.low, type: 'swing_low', time: c.time });
  }
  return swings;
}

// ─── Level-Deduplizierung ─────────────────────────────────────────────────────
// Wenn zwei Level < 0.3% auseinander liegen → zusammenführen (bevorzuge benannten Typ)

function deduplicateLevels(levels, price) {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const merged = [];

  for (const lvl of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(lvl.price - last.price) / price < 0.003) {
      // Cluster: bevorzuge benannten Typ über round_number
      if (lvl.type !== 'round_number') {
        last.type  = lvl.type;
        last.price = lvl.price; // präziser Preis
        if (!last.also) last.also = [];
        last.also.push('round_number');
      } else {
        if (!last.also) last.also = [];
        last.also.push(lvl.type);
      }
    } else {
      merged.push({ ...lvl });
    }
  }
  return merged;
}

// ─── Level-Berechnung für ein Symbol ─────────────────────────────────────────

function computeLevels(sym, symData, proximityPct) {
  const price   = symData.last_close;
  const candles = symData.candles;
  const raw     = [];

  // 1. Runde Zahlen
  for (const lvl of roundLevelsNear(price, proximityPct)) {
    raw.push({ price: lvl, type: 'round_number' });
  }

  // 2. 24h H/L
  raw.push({ price: symData.ticker.high_24h, type: '24h_high' });
  raw.push({ price: symData.ticker.low_24h,  type: '24h_low'  });

  // 3. Session H/L (aus Kerzen)
  if (symData.session_high !== symData.ticker.high_24h) {
    raw.push({ price: symData.session_high, type: 'session_high' });
  }
  if (symData.session_low !== symData.ticker.low_24h) {
    raw.push({ price: symData.session_low, type: 'session_low' });
  }

  // 4. VWAP
  if (symData.vwap) {
    raw.push({ price: symData.vwap, type: 'vwap' });
  }

  // 5. Swing Points
  const swings = detectSwings(candles);
  raw.push(...swings);

  // Filter: nur Level innerhalb des Proximity-Radius (großzügiger für H/L/VWAP)
  const maxDist = price * (proximityPct / 100);
  const filtered = raw.filter(l => {
    const dist = Math.abs(l.price - price);
    // Benannte Level (nicht round_number) immer behalten wenn <15%
    if (l.type !== 'round_number') return dist / price < 0.15;
    return dist <= maxDist;
  });

  // Deduplizieren
  const deduped = deduplicateLevels(filtered, price);

  // Proximity berechnen + direction bestimmen
  const levels = deduped.map(l => ({
    price:         +l.price.toFixed(6),
    type:          l.type,
    also:          l.also || [],
    direction:     l.price > price ? 'resistance' : l.price < price ? 'support' : 'at_price',
    proximity_pct: +(Math.abs(l.price - price) / price * 100).toFixed(3),
    time:          l.time || null,
  })).sort((a, b) => a.proximity_pct - b.proximity_pct);

  return { current_price: price, levels };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function run(argv) {
  const args = parseArgs(argv);

  if (!existsSync(CACHE_IN)) {
    process.stderr.write(JSON.stringify({ error: 'intraday_cache_missing', path: CACHE_IN }) + '\n');
    process.exit(1);
  }

  const cache = JSON.parse(readFileSync(CACHE_IN, 'utf8'));
  const ageMins = (Date.now() - new Date(cache.fetched_at).getTime()) / 60_000;

  if (ageMins > 10) {
    process.stderr.write(JSON.stringify({ warn: 'intraday_cache_stale', age_mins: +ageMins.toFixed(1) }) + '\n');
  }

  let symbols = args.symbols || Object.keys(cache.data);

  const result = { computed_at: new Date().toISOString(), cache_age_mins: +ageMins.toFixed(2), symbols: {} };

  for (const sym of symbols) {
    const symData = cache.data[sym];
    if (!symData) {
      if (!args.quiet) process.stderr.write(
        JSON.stringify({ warn: 'symbol_not_in_cache', symbol: sym }) + '\n'
      );
      continue;
    }
    result.symbols[sym] = computeLevels(sym, symData, args.proximity);
  }

  writeFileSync(CACHE_OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');

  const summary = {
    info:           'level_detection_done',
    symbols:        Object.keys(result.symbols).length,
    computed_at:    result.computed_at,
    cache_age_mins: result.cache_age_mins,
  };

  if (!args.quiet) {
    process.stderr.write(JSON.stringify(summary) + '\n');
  }
  process.stdout.write(JSON.stringify(summary) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'level_detector_crash', detail: e.message }) + '\n');
    process.exit(1);
  }
}

export { computeLevels, detectSwings, roundLevelsNear };
