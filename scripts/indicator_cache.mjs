#!/usr/bin/env node
/**
 * Indicator Cache
 * Stores RSI/MACD readings computed from OHLCV data in a local JSON file.
 * Provides read/write for the indicator cache layer.
 *
 * Usage (CLI):
 *   node indicator_cache.mjs read  SYMBOL
 *   node indicator_cache.mjs write SYMBOL '{"rsi":67.3,"macd_hist":0.45,"macd_signal":"bullish"}'
 *
 * Usage (module):
 *   import { readIndicatorCache, writeIndicatorCache } from './indicator_cache.mjs'
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath }                            from 'url';
import { dirname, join, resolve }                   from 'path';

const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const CACHE_PATH      = join(TRADING_DIR, 'cache', 'indicator_cache.json');
const LEGACY_PATH     = join(TRADING_DIR, 'cache', 'tv_data.json');
const DEFAULT_MAX_AGE     = 60;          // daily RSI/MACD: stale after 60 min
const MAX_AGE_WEEKLY_MIN  = 24 * 60;    // weekly RSI: fresh for 24 h
const MAX_AGE_MONTHLY_MIN = 7 * 24 * 60; // monthly RSI: fresh for 7 days

// --- Cache I/O -------------------------------------------------------------

function loadCache() {
  // Try new path first; fall back to legacy tv_data.json with a warning (one-session compat)
  if (existsSync(CACHE_PATH)) {
    try   { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); }
    catch { return {}; }
  }
  if (existsSync(LEGACY_PATH)) {
    process.stderr.write(JSON.stringify({ warning: 'indicator_cache_legacy_fallback', detail: 'reading tv_data.json — rename to indicator_cache.json on next write' }) + '\n');
    try   { return JSON.parse(readFileSync(LEGACY_PATH, 'utf8')); }
    catch { return {}; }
  }
  return {};
}

function saveCache(data) {
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// --- Public API ------------------------------------------------------------

export function readIndicatorCache(symbol, maxAgeMinutes = DEFAULT_MAX_AGE) {
  const cache = loadCache();
  const entry = cache[symbol.toUpperCase()];

  if (!entry) {
    return { available: false, reason: 'not_found', symbol: symbol.toUpperCase() };
  }

  const ageMs      = Date.now() - new Date(entry.updated_at).getTime();
  const ageMinutes = +(ageMs / 60_000).toFixed(1);

  if (ageMinutes > maxAgeMinutes) {
    return {
      available:    false,
      reason:       'stale',
      symbol:       symbol.toUpperCase(),
      age_minutes:  ageMinutes,
      last_updated: entry.updated_at,
    };
  }

  if (entry.rsi == null) {
    return {
      available:   false,
      reason:      'rsi_null',
      symbol:      symbol.toUpperCase(),
      age_minutes: ageMinutes,
    };
  }

  const rsiWeekly = (() => {
    if (entry.rsi_weekly == null || !entry.rsi_weekly_updated_at) return null;
    const age = (Date.now() - new Date(entry.rsi_weekly_updated_at).getTime()) / 60_000;
    return age <= MAX_AGE_WEEKLY_MIN ? entry.rsi_weekly : null;
  })();

  const rsiMonthly = (() => {
    if (entry.rsi_monthly == null || !entry.rsi_monthly_updated_at) return null;
    const age = (Date.now() - new Date(entry.rsi_monthly_updated_at).getTime()) / 60_000;
    return age <= MAX_AGE_MONTHLY_MIN ? entry.rsi_monthly : null;
  })();

  return {
    available:   true,
    symbol:      symbol.toUpperCase(),
    rsi:         entry.rsi,
    rsi_weekly:  rsiWeekly,
    rsi_monthly: rsiMonthly,
    macd_hist:   entry.macd_hist   ?? null,
    macd_signal: entry.macd_signal ?? null,
    age_minutes: ageMinutes,
    updated_at:  entry.updated_at,
  };
}

export function readClosesFromCache(symbol) {
  const cache = loadCache();
  const entry = cache[symbol.toUpperCase()];
  const c20 = entry?.closes_20;
  if (!Array.isArray(c20) || c20.length < 20) {
    return { available: false, reason: 'no_closes_in_cache' };
  }
  return { available: true, closes_20: c20 };
}

export function writeIndicatorCache(symbol, data) {
  const cache    = loadCache();
  const existing = cache[symbol.toUpperCase()] ?? {};
  cache[symbol.toUpperCase()] = {
    ...existing,                            // preserve rsi_weekly / rsi_monthly
    rsi:         data.rsi         ?? null,
    macd_hist:   data.macd_hist   ?? null,
    macd_signal: data.macd_signal ?? null,
    updated_at:  new Date().toISOString(),
  };
  saveCache(cache);
  return { ok: true, symbol: symbol.toUpperCase() };
}

/**
 * pruneIndicatorCache — removes entries older than maxAgeMinutes.
 * Called once per scan cycle after all indicators have been written.
 * Returns { pruned: N, kept: M } for logging.
 */
export function pruneIndicatorCache(maxAgeMinutes = DEFAULT_MAX_AGE) {
  const cache = loadCache();
  const now   = Date.now();
  let pruned  = 0;
  for (const symbol of Object.keys(cache)) {
    const entry = cache[symbol];
    if (!entry?.updated_at) { delete cache[symbol]; pruned++; continue; }
    const ageMs = now - new Date(entry.updated_at).getTime();
    if (ageMs / 60_000 > maxAgeMinutes) { delete cache[symbol]; pruned++; }
  }
  if (pruned > 0) saveCache(cache);
  return { pruned, kept: Object.keys(cache).length };
}

// --- CLI mode (only when run directly) ------------------------------------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const [,, command, symbol, jsonArg] = process.argv;

  if (!command || !symbol) {
    process.stderr.write(
      'Usage:\n  node indicator_cache.mjs read  SYMBOL\n' +
      '  node indicator_cache.mjs write SYMBOL \'{"rsi":67.3,"macd_hist":0.45,"macd_signal":"bullish"}\'\n'
    );
    process.exit(1);
  }

  try {
    if (command === 'read') {
      const result = readIndicatorCache(symbol);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');

    } else if (command === 'write') {
      if (!jsonArg) {
        process.stderr.write('Error: missing JSON data argument\n');
        process.exit(1);
      }
      const data   = JSON.parse(jsonArg);
      const result = writeIndicatorCache(symbol, data);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');

    } else {
      process.stderr.write(`Unknown command: "${command}". Use "read" or "write".\n`);
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(1);
  }
}
