#!/usr/bin/env node
/**
 * OHLCV Fetcher
 * Reads the latest research_run log, fetches 50 daily closes for candidates
 * where technical.available = false, and writes ohlcv_pending.json.
 *
 * Also writes full OHLCV candles (200 bars) for SMC_SYMBOLS to
 * trading/cache/ohlcv_daily_{SYMBOL}.json — used by smc_detector.py and
 * regime_filter.py (ATR, swing detection, EMA200).
 *
 * Also writes 4H OHLCV candles (100 bars) for SMC_SYMBOLS to
 * trading/cache/ohlcv_4h_{SYMBOL}.json — used by smc_detector.py for
 * intraday IDM sweep detection.
 *
 * Stocks  → Yahoo Finance (v8/finance/chart, interval=1d, range=3mo)
 * Crypto  → Bitunix Futures (api/v1/futures/market/kline, interval=1d, limit=200)
 *
 * Usage: node ohlcv_fetcher.mjs
 * Output: ohlcv_pending.json written to trading/cache/
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const LOGS_DIR     = join(TRADING_DIR, 'logs');
const CACHE_DIR    = join(TRADING_DIR, 'cache');
const PENDING_PATH         = join(TRADING_DIR, 'cache', 'ohlcv_pending.json');
const PENDING_WEEKLY_PATH  = join(TRADING_DIR, 'cache', 'ohlcv_pending_weekly.json');
const PENDING_MONTHLY_PATH = join(TRADING_DIR, 'cache', 'ohlcv_pending_monthly.json');
const YAHOO_BASE   = 'https://query1.finance.yahoo.com/v8/finance/chart';
const BITUNIX_BASE = 'https://fapi.bitunix.com';
const RANGE        = '3mo';  // ~60 trading days → well above the 35-close minimum
const INTERVAL     = '1d';
const TARGET_COUNT = 50;
const MIN_COUNT    = 35;
const TIMEOUT_MS   = 8_000;

// SMC full-OHLCV dump — always fetched for these symbols (regime_filter + smc_detector)
const SMC_SYMBOLS         = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'TAO'];
const SMC_CANDLE_LIMIT    = 200;   // EMA200 needs exactly 200 bars
const SMC_MIN_CANDLES     = 150;
const SMC_FRESHNESS_MS    = 30 * 60 * 1000;  // skip re-fetch if file < 30 min old

// SMC 4H OHLCV — intraday IDM sweep detection
const SMC_4H_CANDLE_LIMIT = 100;   // ~16 days of 4H bars
const SMC_4H_MIN_CANDLES  = 10;
const SMC_4H_FRESHNESS_MS = 30 * 60 * 1000;  // same 30-min freshness skip

// SMC 1H OHLCV — 882 Fib entry level (level_entry.py)
const SMC_1H_CANDLE_LIMIT = 200;   // ~8 days of 1H bars
const SMC_1H_MIN_CANDLES  = 20;
const SMC_1H_FRESHNESS_MS = 30 * 60 * 1000;

// SMC 15m OHLCV — LSOB sweep confirmation (level_entry.py)
const SMC_15M_CANDLE_LIMIT = 200;  // ~50h of 15m bars
const SMC_15M_MIN_CANDLES  = 4;
const SMC_15M_FRESHNESS_MS = 30 * 60 * 1000;

// Weekly / monthly — looser requirements (RSI(14) needs only 15 candles)
const MIN_COUNT_WEEKLY  = 15;
const MIN_COUNT_MONTHLY = 15;

// --- Load latest run log --------------------------------------------------------

function loadLatestRun() {
  const files = readdirSync(LOGS_DIR)
    .filter(f => f.startsWith('run_') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (!files.length) throw new Error(`No run log found in ${LOGS_DIR}`);
  return JSON.parse(readFileSync(join(LOGS_DIR, files[0]), 'utf8'));
}

// --- Yahoo Finance close fetch --------------------------------------------------

async function fetchCloses(symbol) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url        = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=${INTERVAL}&range=${RANGE}`;

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result)  throw new Error('no_result_in_response');

    const raw    = result.indicators?.quote?.[0]?.close ?? [];
    const valid  = raw.filter(v => v !== null && Number.isFinite(v));
    return valid.slice(-TARGET_COUNT);

  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// --- Bitunix Futures close fetch ------------------------------------------------

async function fetchCryptoCloses(symbol) {
  const bitunixSymbol = symbol.toUpperCase() + 'USDT';
  const controller    = new AbortController();
  const timer         = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url           = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${bitunixSymbol}&interval=1d&limit=200&type=LAST_PRICE`;

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.code !== 0) throw new Error(`api_error_${json.code}: ${json.msg ?? 'unknown'}`);

    const rows = json.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error('empty_response');

    const closes = rows
      .map(k => parseFloat(k.close))
      .filter(v => Number.isFinite(v))
      .reverse();

    return closes.slice(-TARGET_COUNT);

  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// --- Yahoo Finance weekly / monthly fetch --------------------------------------

async function fetchClosesYahoo(symbol, interval, range, targetCount) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url        = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result)  throw new Error('no_result_in_response');

    const raw   = result.indicators?.quote?.[0]?.close ?? [];
    const valid = raw.filter(v => v !== null && Number.isFinite(v));
    return valid.slice(-targetCount);

  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// --- Bitunix Futures weekly / monthly fetch ------------------------------------

async function fetchCryptoClosesBitunix(symbol, interval, limit) {
  const bitunixSymbol = symbol.toUpperCase() + 'USDT';
  const controller    = new AbortController();
  const timer         = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url           = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${bitunixSymbol}&interval=${interval}&limit=${limit}&type=LAST_PRICE`;

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.code !== 0) throw new Error(`api_error_${json.code}: ${json.msg ?? 'unknown'}`);

    const rows = json.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error('empty_response');

    return rows
      .map(k => parseFloat(k.close))
      .filter(v => Number.isFinite(v))
      .reverse();

  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// --- SMC full-OHLCV fetch (Bitunix, daily) — returns [{timestamp,open,high,low,close,volume}] ---

async function fetchCryptoOHLCV(symbol, limit = SMC_CANDLE_LIMIT) {
  const bitunixSymbol = symbol.toUpperCase() + 'USDT';
  const controller    = new AbortController();
  const timer         = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url           = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${bitunixSymbol}&interval=1d&limit=${limit}&type=LAST_PRICE`;

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.code !== 0) throw new Error(`api_error_${json.code}: ${json.msg ?? 'unknown'}`);

    const rows = json.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error('empty_response');

    // Bitunix returns newest-first; reverse to oldest-first (chronological)
    const candles = rows
      .map(k => ({
        timestamp: typeof k.time === 'number' ? k.time : parseInt(k.time, 10),
        open:      parseFloat(k.open),
        high:      parseFloat(k.high),
        low:       parseFloat(k.low),
        close:     parseFloat(k.close),
        volume:    parseFloat(k.volume ?? k.qty ?? 0),
      }))
      .filter(c =>
        Number.isFinite(c.timestamp) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .reverse();

    return candles;

  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// --- Generic Bitunix interval fetch — reused for 1H and 15m ------------------

async function fetchCryptoOHLCVInterval(symbol, interval, limit) {
  const bitunixSymbol = symbol.toUpperCase() + 'USDT';
  const controller    = new AbortController();
  const timer         = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url           = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${bitunixSymbol}&interval=${interval}&limit=${limit}&type=LAST_PRICE`;

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.code !== 0) throw new Error(`api_error_${json.code}: ${json.msg ?? 'unknown'}`);

    const rows = json.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error('empty_response');

    const candles = rows
      .map(k => ({
        timestamp: typeof k.time === 'number' ? k.time : parseInt(k.time, 10),
        open:      parseFloat(k.open),
        high:      parseFloat(k.high),
        low:       parseFloat(k.low),
        close:     parseFloat(k.close),
        volume:    parseFloat(k.volume ?? k.qty ?? 0),
      }))
      .filter(c =>
        Number.isFinite(c.timestamp) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .reverse();

    return candles;

  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// --- SMC 4H-OHLCV fetch (Bitunix) — same structure as daily, interval=4h ------

async function fetchCryptoOHLCV4h(symbol, limit = SMC_4H_CANDLE_LIMIT) {
  const bitunixSymbol = symbol.toUpperCase() + 'USDT';
  const controller    = new AbortController();
  const timer         = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url           = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${bitunixSymbol}&interval=4h&limit=${limit}&type=LAST_PRICE`;

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.code !== 0) throw new Error(`api_error_${json.code}: ${json.msg ?? 'unknown'}`);

    const rows = json.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error('empty_response');

    const candles = rows
      .map(k => ({
        timestamp: typeof k.time === 'number' ? k.time : parseInt(k.time, 10),
        open:      parseFloat(k.open),
        high:      parseFloat(k.high),
        low:       parseFloat(k.low),
        close:     parseFloat(k.close),
        volume:    parseFloat(k.volume ?? k.qty ?? 0),
      }))
      .filter(c =>
        Number.isFinite(c.timestamp) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .reverse();

    return candles;

  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// --- Main -----------------------------------------------------------------------

async function main() {
  const run = loadLatestRun();
  const pinnedStandalone = (run.pinned_watchlist ?? [])
    .filter(p => p.in_candidates !== true && p.available === true);
  const all = [...(run.long_candidates ?? []), ...(run.short_candidates ?? []), ...pinnedStandalone];

  // Daily OHLCV: only for candidates without fresh technical data
  const needsFetch   = all.filter(c => !c.technical?.available);
  const stocks       = needsFetch.filter(c => c.category === 'Stock');
  const crypto       = needsFetch.filter(c => c.category !== 'Stock');

  // Weekly/monthly OHLCV: independent of daily
  const needsWeekly  = all.filter(c => c.technical?.rsi_weekly  == null);
  const needsMonthly = all.filter(c => c.technical?.rsi_monthly == null);

  if (!needsFetch.length && !needsWeekly.length && !needsMonthly.length) {
    process.stderr.write(JSON.stringify({ info: 'ohlcv_fetcher_nothing_to_fetch' }) + '\n');
    process.exit(0);
  }

  process.stderr.write(JSON.stringify({
    info:          'ohlcv_fetcher_start',
    stocks:        stocks.map(c => c.symbol),
    crypto:        crypto.map(c => c.symbol),
    needs_weekly:  needsWeekly.map(c => c.symbol),
    needs_monthly: needsMonthly.map(c => c.symbol),
  }) + '\n');

  const pending = {};
  const failed  = [];

  // Stocks via Yahoo Finance
  for (const candidate of stocks) {
    const sym = candidate.symbol;
    try {
      const closes = await fetchCloses(sym);
      if (closes.length < MIN_COUNT) {
        process.stderr.write(JSON.stringify({ warning: 'ohlcv_fetcher_too_few', symbol: sym, source: 'yahoo', count: closes.length, required: MIN_COUNT }) + '\n');
        failed.push(sym);
        continue;
      }
      pending[sym] = closes;
      process.stderr.write(JSON.stringify({ info: 'ohlcv_fetcher_ok', symbol: sym, source: 'yahoo', count: closes.length }) + '\n');
    } catch (e) {
      process.stderr.write(JSON.stringify({ warning: 'ohlcv_fetcher_failed', symbol: sym, source: 'yahoo', error: e.message }) + '\n');
      failed.push(sym);
    }
  }

  // Crypto via Bitunix Futures
  for (const candidate of crypto) {
    const sym = candidate.symbol;
    try {
      const closes = await fetchCryptoCloses(sym);
      if (closes.length < MIN_COUNT) {
        process.stderr.write(JSON.stringify({ warning: 'ohlcv_fetcher_too_few', symbol: sym, source: 'bitunix', count: closes.length, required: MIN_COUNT }) + '\n');
        failed.push(sym);
        continue;
      }
      pending[sym] = closes;
      process.stderr.write(JSON.stringify({ info: 'ohlcv_fetcher_ok', symbol: sym, source: 'bitunix', count: closes.length }) + '\n');
    } catch (e) {
      process.stderr.write(JSON.stringify({ warning: 'ohlcv_fetcher_failed', symbol: sym, source: 'bitunix', error: e.message }) + '\n');
      failed.push(sym);
    }
  }

  if (Object.keys(pending).length) {
    writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n', 'utf8');
    process.stderr.write(JSON.stringify({ info: 'ohlcv_pending_written', written: Object.keys(pending), failed }) + '\n');
  } else if (failed.length) {
    process.stderr.write(JSON.stringify({ warn: 'ohlcv_fetcher_no_valid_data', failed, note: 'all daily symbols skipped — scan continues without OHLCV enrichment' }) + '\n');
  }

  // --- Weekly closes (fail-soft) ---
  const pendingWeekly = {};
  for (const candidate of needsWeekly) {
    const sym     = candidate.symbol;
    const isStock = candidate.category === 'Stock';
    try {
      const closes = isStock
        ? await fetchClosesYahoo(sym, '1wk', '2y', 50)
        : await fetchCryptoClosesBitunix(sym, '1w', 100);
      if (closes.length >= MIN_COUNT_WEEKLY) {
        pendingWeekly[sym] = closes;
        process.stderr.write(JSON.stringify({ info: 'ohlcv_weekly_ok', symbol: sym, count: closes.length }) + '\n');
      } else {
        process.stderr.write(JSON.stringify({ warning: 'ohlcv_weekly_too_few', symbol: sym, count: closes.length }) + '\n');
      }
    } catch (e) {
      process.stderr.write(JSON.stringify({ warning: 'ohlcv_weekly_failed', symbol: sym, error: e.message }) + '\n');
    }
  }
  if (Object.keys(pendingWeekly).length) {
    writeFileSync(PENDING_WEEKLY_PATH, JSON.stringify(pendingWeekly, null, 2) + '\n', 'utf8');
    process.stderr.write(JSON.stringify({ info: 'ohlcv_pending_weekly_written', written: Object.keys(pendingWeekly) }) + '\n');
  }

  // --- Monthly closes (fail-soft) ---
  const pendingMonthly = {};
  for (const candidate of needsMonthly) {
    const sym     = candidate.symbol;
    const isStock = candidate.category === 'Stock';
    try {
      const closes = isStock
        ? await fetchClosesYahoo(sym, '1mo', '10y', 60)
        : await fetchCryptoClosesBitunix(sym, '1M', 60);
      if (closes.length >= MIN_COUNT_MONTHLY) {
        pendingMonthly[sym] = closes;
        process.stderr.write(JSON.stringify({ info: 'ohlcv_monthly_ok', symbol: sym, count: closes.length }) + '\n');
      } else {
        process.stderr.write(JSON.stringify({ warning: 'ohlcv_monthly_too_few', symbol: sym, count: closes.length }) + '\n');
      }
    } catch (e) {
      process.stderr.write(JSON.stringify({ warning: 'ohlcv_monthly_failed', symbol: sym, error: e.message }) + '\n');
    }
  }
  if (Object.keys(pendingMonthly).length) {
    writeFileSync(PENDING_MONTHLY_PATH, JSON.stringify(pendingMonthly, null, 2) + '\n', 'utf8');
    process.stderr.write(JSON.stringify({ info: 'ohlcv_pending_monthly_written', written: Object.keys(pendingMonthly) }) + '\n');
  }

  // --- SMC daily full-OHLCV dump (fail-soft per symbol) ---
  const smcWritten = [];
  const smcFailed  = [];
  const smcSkipped = [];

  for (const sym of SMC_SYMBOLS) {
    const outPath = join(CACHE_DIR, `ohlcv_daily_${sym}.json`);

    if (existsSync(outPath)) {
      const ageSec = (Date.now() - statSync(outPath).mtimeMs) / 1000;
      if (ageSec < SMC_FRESHNESS_MS / 1000) {
        smcSkipped.push(sym);
        process.stderr.write(JSON.stringify({ info: 'smc_ohlcv_fresh', symbol: sym, age_sec: Math.round(ageSec) }) + '\n');
        continue;
      }
    }

    try {
      const candles = await fetchCryptoOHLCV(sym);
      if (candles.length < SMC_MIN_CANDLES) {
        process.stderr.write(JSON.stringify({ warning: 'smc_ohlcv_too_few', symbol: sym, count: candles.length, required: SMC_MIN_CANDLES }) + '\n');
        smcFailed.push(sym);
        continue;
      }
      writeFileSync(outPath, JSON.stringify(candles, null, 2) + '\n', 'utf8');
      smcWritten.push(sym);
      process.stderr.write(JSON.stringify({ info: 'smc_ohlcv_written', symbol: sym, candles: candles.length, path: outPath }) + '\n');
    } catch (e) {
      process.stderr.write(JSON.stringify({ warning: 'smc_ohlcv_failed', symbol: sym, error: e.message }) + '\n');
      smcFailed.push(sym);
    }
  }

  if (smcWritten.length || smcFailed.length) {
    process.stderr.write(JSON.stringify({ info: 'smc_ohlcv_summary', written: smcWritten, failed: smcFailed, skipped: smcSkipped }) + '\n');
  }

  // --- SMC 4H OHLCV dump (fail-soft per symbol) ---
  const smc4hWritten = [];
  const smc4hFailed  = [];
  const smc4hSkipped = [];

  for (const sym of SMC_SYMBOLS) {
    const outPath = join(CACHE_DIR, `ohlcv_4h_${sym}.json`);

    if (existsSync(outPath)) {
      const ageSec = (Date.now() - statSync(outPath).mtimeMs) / 1000;
      if (ageSec < SMC_4H_FRESHNESS_MS / 1000) {
        smc4hSkipped.push(sym);
        process.stderr.write(JSON.stringify({ info: 'smc_4h_fresh', symbol: sym, age_sec: Math.round(ageSec) }) + '\n');
        continue;
      }
    }

    try {
      const candles = await fetchCryptoOHLCV4h(sym);
      if (candles.length < SMC_4H_MIN_CANDLES) {
        process.stderr.write(JSON.stringify({ warning: 'smc_4h_too_few', symbol: sym, count: candles.length, required: SMC_4H_MIN_CANDLES }) + '\n');
        smc4hFailed.push(sym);
        continue;
      }
      writeFileSync(outPath, JSON.stringify(candles, null, 2) + '\n', 'utf8');
      smc4hWritten.push(sym);
      process.stderr.write(JSON.stringify({ info: 'smc_4h_written', symbol: sym, candles: candles.length, path: outPath }) + '\n');
    } catch (e) {
      process.stderr.write(JSON.stringify({ warning: 'smc_4h_failed', symbol: sym, error: e.message }) + '\n');
      smc4hFailed.push(sym);
    }
  }

  if (smc4hWritten.length || smc4hFailed.length) {
    process.stderr.write(JSON.stringify({ info: 'smc_4h_summary', written: smc4hWritten, failed: smc4hFailed, skipped: smc4hSkipped }) + '\n');
  }

  // --- SMC 1H OHLCV dump (fail-soft per symbol) ---
  const smc1hWritten = [];
  const smc1hFailed  = [];
  const smc1hSkipped = [];

  for (const sym of SMC_SYMBOLS) {
    const outPath = join(CACHE_DIR, `ohlcv_1h_${sym}.json`);

    if (existsSync(outPath)) {
      const ageSec = (Date.now() - statSync(outPath).mtimeMs) / 1000;
      if (ageSec < SMC_1H_FRESHNESS_MS / 1000) {
        smc1hSkipped.push(sym);
        process.stderr.write(JSON.stringify({ info: 'smc_1h_fresh', symbol: sym, age_sec: Math.round(ageSec) }) + '\n');
        continue;
      }
    }

    try {
      const candles = await fetchCryptoOHLCVInterval(sym, '1h', SMC_1H_CANDLE_LIMIT);
      if (candles.length < SMC_1H_MIN_CANDLES) {
        process.stderr.write(JSON.stringify({ warning: 'smc_1h_too_few', symbol: sym, count: candles.length }) + '\n');
        smc1hFailed.push(sym);
        continue;
      }
      writeFileSync(outPath, JSON.stringify(candles, null, 2) + '\n', 'utf8');
      smc1hWritten.push(sym);
      process.stderr.write(JSON.stringify({ info: 'smc_1h_written', symbol: sym, candles: candles.length, path: outPath }) + '\n');
    } catch (e) {
      process.stderr.write(JSON.stringify({ warning: 'smc_1h_failed', symbol: sym, error: e.message }) + '\n');
      smc1hFailed.push(sym);
    }
  }

  if (smc1hWritten.length || smc1hFailed.length) {
    process.stderr.write(JSON.stringify({ info: 'smc_1h_summary', written: smc1hWritten, failed: smc1hFailed, skipped: smc1hSkipped }) + '\n');
  }

  // --- SMC 15m OHLCV dump (fail-soft per symbol) ---
  const smc15mWritten = [];
  const smc15mFailed  = [];
  const smc15mSkipped = [];

  for (const sym of SMC_SYMBOLS) {
    const outPath = join(CACHE_DIR, `ohlcv_15m_${sym}.json`);

    if (existsSync(outPath)) {
      const ageSec = (Date.now() - statSync(outPath).mtimeMs) / 1000;
      if (ageSec < SMC_15M_FRESHNESS_MS / 1000) {
        smc15mSkipped.push(sym);
        process.stderr.write(JSON.stringify({ info: 'smc_15m_fresh', symbol: sym, age_sec: Math.round(ageSec) }) + '\n');
        continue;
      }
    }

    try {
      const candles = await fetchCryptoOHLCVInterval(sym, '15m', SMC_15M_CANDLE_LIMIT);
      if (candles.length < SMC_15M_MIN_CANDLES) {
        process.stderr.write(JSON.stringify({ warning: 'smc_15m_too_few', symbol: sym, count: candles.length }) + '\n');
        smc15mFailed.push(sym);
        continue;
      }
      writeFileSync(outPath, JSON.stringify(candles, null, 2) + '\n', 'utf8');
      smc15mWritten.push(sym);
      process.stderr.write(JSON.stringify({ info: 'smc_15m_written', symbol: sym, candles: candles.length, path: outPath }) + '\n');
    } catch (e) {
      process.stderr.write(JSON.stringify({ warning: 'smc_15m_failed', symbol: sym, error: e.message }) + '\n');
      smc15mFailed.push(sym);
    }
  }

  if (smc15mWritten.length || smc15mFailed.length) {
    process.stderr.write(JSON.stringify({ info: 'smc_15m_summary', written: smc15mWritten, failed: smc15mFailed, skipped: smc15mSkipped }) + '\n');
  }

  process.stdout.write(JSON.stringify({
    ok:            true,
    written:       Object.keys(pending),
    failed,
    smc_written:   smcWritten,
    smc_failed:    smcFailed,
    smc_skipped:   smcSkipped,
    smc4h_written: smc4hWritten,
    smc4h_failed:  smc4hFailed,
    smc4h_skipped: smc4hSkipped,
    smc1h_written: smc1hWritten,
    smc1h_failed:  smc1hFailed,
    smc1h_skipped: smc1hSkipped,
    smc15m_written: smc15mWritten,
    smc15m_failed:  smc15mFailed,
    smc15m_skipped: smc15mSkipped,
  }) + '\n');
}

main().catch(e => {
  process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
  process.exit(1);
});
