#!/usr/bin/env node
/**
 * MACD Calculator — Standard EMA(12, 26, 9)
 *
 * Usage:
 *   node macd_calc.mjs <SYMBOL> '<closes-json>'
 *
 * closes-json: JSON array of finite numbers, oldest-first/newest-last, min 34 values.
 * Writes macd_hist + macd_signal into indicator_cache.json (merge-safe, atomic write).
 *
 * macd_hist:   MACD line minus signal line, rounded to 4 decimal places
 * macd_signal: "bullish" | "bearish" | "neutral" derived from histogram sign
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

// Identical to the constant in indicator_cache.mjs and rsi_calc.mjs.
const CACHE_PATH = join(TRADING_DIR, 'cache', 'indicator_cache.json');
const FAST       = 12;
const SLOW       = 26;
const SIGNAL_P   = 9;
const MIN_CLOSES = SLOW + SIGNAL_P - 1; // 34 — first seed signal EMA is computable

function fail(message, detail) {
  const payload = detail ? { error: message, detail } : { error: message };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [, , symbolArg, closesArg] = argv;

  if (!symbolArg || !closesArg) {
    fail('usage', "node macd_calc.mjs <SYMBOL> '<closes-json>'");
  }

  const symbol = String(symbolArg).trim().toUpperCase();
  if (!symbol) fail('invalid_symbol', 'Symbol must be a non-empty string.');

  let closes;
  try {
    closes = JSON.parse(closesArg);
  } catch (e) {
    fail('invalid_json', e.message);
  }

  if (!Array.isArray(closes))
    fail('invalid_closes', 'Closes must be a JSON array.');
  if (closes.some(v => typeof v !== 'number' || !Number.isFinite(v)))
    fail('invalid_closes', 'Closes must be a JSON array of finite numbers.');

  return { symbol, closes };
}

// Returns an array of the same length as `values`.
// First (period - 1) entries are null (warmup); index (period - 1) is the seed average.
function emaFull(values, period) {
  if (values.length < period) {
    throw new Error(`Need at least ${period} values for EMA(${period}).`);
  }
  const k      = 2 / (period + 1);
  const result = new Array(period - 1).fill(null);
  let   prev   = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function computeMACD(closes) {
  if (closes.length < MIN_CLOSES) {
    throw new Error(`Need at least ${MIN_CLOSES} closes, got ${closes.length}.`);
  }

  const fastArr = emaFull(closes, FAST);
  const slowArr = emaFull(closes, SLOW);

  // MACD line: defined from index SLOW-1 onward
  const macdLine = [];
  for (let i = SLOW - 1; i < closes.length; i++) {
    macdLine.push(fastArr[i] - slowArr[i]);
  }

  const signalArr = emaFull(macdLine, SIGNAL_P);

  const hist   = +(macdLine.at(-1) - signalArr.at(-1)).toFixed(4);
  const signal = hist > 0 ? 'bullish' : hist < 0 ? 'bearish' : 'neutral';

  return { macd_hist: hist, macd_signal: signal };
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch { return {}; }
}

function atomicWriteJson(filePath, data) {
  const tempPath = join(
    dirname(filePath),
    `.tmp-indicator_cache-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tempPath, filePath);
}

function writeMacd(symbol, macd_hist, macd_signal) {
  const cache = loadCache();
  const existing = cache[symbol] && typeof cache[symbol] === 'object' && !Array.isArray(cache[symbol])
    ? cache[symbol]
    : {};

  cache[symbol] = { ...existing, macd_hist, macd_signal, updated_at: new Date().toISOString() };
  atomicWriteJson(CACHE_PATH, cache);

  return { ok: true, symbol, macd_hist, macd_signal, cache_path: CACHE_PATH };
}

function main() {
  const { symbol, closes } = parseArgs(process.argv);

  let macd;
  try {
    macd = computeMACD(closes);
  } catch (e) {
    fail('macd_calc_failed', e.message);
  }

  const result = writeMacd(symbol, macd.macd_hist, macd.macd_signal);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
