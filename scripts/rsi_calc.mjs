#!/usr/bin/env node
/**
 * RSI Calculator — Wilder RSI(14)
 *
 * Usage:
 *   node rsi_calc.mjs <SYMBOL> '<closes-json>' [--timeframe daily|weekly|monthly]
 *
 * Example:
 *   node rsi_calc.mjs ENPH "[44.34,...]"                         # daily (default)
 *   node rsi_calc.mjs BTC  "[44.34,...]" --timeframe weekly      # weekly
 *   node rsi_calc.mjs BTC  "[44.34,...]" --timeframe monthly     # monthly
 *
 * Behavior:
 * - daily   → writes cache[SYMBOL].rsi + cache[SYMBOL].updated_at
 * - weekly  → writes cache[SYMBOL].rsi_weekly + rsi_weekly_updated_at
 * - monthly → writes cache[SYMBOL].rsi_monthly + rsi_monthly_updated_at
 * - All timeframes preserve existing fields via spread (atomic write + renameSync)
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const CACHE_PATH = join(TRADING_DIR, 'cache', 'indicator_cache.json');
const PERIOD = 14;

function fail(message, detail) {
  const payload = detail ? { error: message, detail } : { error: message };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exit(1);
}

const VALID_TIMEFRAMES = new Set(['daily', 'weekly', 'monthly']);

// Maps timeframe → { rsi_key, ts_key } in indicator_cache.json
const TF_FIELDS = {
  daily:   { rsi_key: 'rsi',         ts_key: 'updated_at' },
  weekly:  { rsi_key: 'rsi_weekly',  ts_key: 'rsi_weekly_updated_at' },
  monthly: { rsi_key: 'rsi_monthly', ts_key: 'rsi_monthly_updated_at' },
};

function parseArgs(argv) {
  // Separate positional args from --flags
  const positional = argv.slice(2).filter(a => !a.startsWith('--'));
  const [symbolArg, closesArg] = positional;

  const tfIdx    = argv.indexOf('--timeframe');
  const timeframe = tfIdx !== -1 && argv[tfIdx + 1] ? argv[tfIdx + 1] : 'daily';

  if (!VALID_TIMEFRAMES.has(timeframe)) {
    fail('invalid_timeframe', `Must be daily, weekly, or monthly; got: ${timeframe}`);
  }

  if (!symbolArg || !closesArg) {
    fail('usage', "node rsi_calc.mjs <SYMBOL> '<closes-json>' [--timeframe daily|weekly|monthly]");
  }

  const symbol = String(symbolArg).trim().toUpperCase();
  if (!symbol) {
    fail('invalid_symbol', 'Symbol must be a non-empty string.');
  }

  let closes;
  try {
    closes = JSON.parse(closesArg);
  } catch (error) {
    fail('invalid_json', error.message);
  }

  if (!Array.isArray(closes)) {
    fail('invalid_closes', 'Closes must be a JSON array.');
  }

  if (closes.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    fail('invalid_closes', 'Closes must be a JSON array of finite numbers.');
  }

  return { symbol, closes, timeframe };
}

function computeRsiWilder(closes, period = PERIOD) {
  if (closes.length < period + 1) {
    throw new Error(`Need at least ${period + 1} closes, got ${closes.length}.`);
  }

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      gainSum += change;
    } else if (change < 0) {
      lossSum += Math.abs(change);
    }
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgGain === 0 && avgLoss === 0) return 50.0;
  if (avgLoss === 0) return 100.0;
  if (avgGain === 0) return 0.0;

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return Number(rsi.toFixed(2));
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) {
    return {};
  }

  try {
    const raw = readFileSync(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

function atomicWriteJson(filePath, data) {
  const tempPath = join(
    dirname(filePath),
    `.tmp-indicator_cache-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tempPath, filePath);
}

function writeRsi(symbol, rsi, timeframe, closes) {
  const { rsi_key, ts_key } = TF_FIELDS[timeframe];
  const cache = loadCache();
  const existingEntry = cache[symbol] && typeof cache[symbol] === 'object' && !Array.isArray(cache[symbol])
    ? cache[symbol]
    : {};

  const now = new Date().toISOString();

  cache[symbol] = {
    ...existingEntry,
    [rsi_key]: rsi,
    [ts_key]:  now,
    ...(timeframe === 'daily' && Array.isArray(closes) ? { closes_20: closes.slice(-20) } : {}),
  };

  atomicWriteJson(CACHE_PATH, cache);

  return {
    ok: true,
    symbol,
    timeframe,
    rsi,
    [ts_key]:  now,
    cache_path: CACHE_PATH,
  };
}

function main() {
  const { symbol, closes, timeframe } = parseArgs(process.argv);

  let rsi;
  try {
    rsi = computeRsiWilder(closes, PERIOD);
  } catch (error) {
    fail('rsi_calc_failed', error.message);
  }

  const result = writeRsi(symbol, rsi, timeframe, closes);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
