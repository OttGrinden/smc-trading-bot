#!/usr/bin/env node
/**
 * intraday_fetcher.mjs — Intraday OHLCV Fetcher (Bitunix Futures)
 *
 * Fetcht 5-Minuten-Kerzen + 24h-Ticker für die Top-N Bitunix-Symbole
 * (Crypto + Tokenized Stocks). Berechnet VWAP und Session-H/L.
 *
 * Schreibt: trading/cache/intraday_cache.json
 *
 * Usage:
 *   node intraday_fetcher.mjs                        # Top-25 nach Volumen
 *   node intraday_fetcher.mjs --symbols BTC,ETH,SNDK # Explizite Liste
 *   node intraday_fetcher.mjs --top 40               # Top-40 nach Volumen
 *   node intraday_fetcher.mjs --candles 200          # Mehr Kerzen (Standard: 100)
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath }                           from 'url';
import { dirname, join, resolve }                  from 'path';

const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const CACHE_PATH   = join(TRADING_DIR, 'cache', 'intraday_cache.json');
const BITUNIX_BASE = 'https://fapi.bitunix.com';
const TIMEOUT_MS   = 8_000;
const BATCH_SIZE   = 6;    // parallele Requests pro Batch
const BATCH_DELAY  = 200;  // ms zwischen Batches

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const symIdx     = argv.indexOf('--symbols');
  const topIdx     = argv.indexOf('--top');
  const candlesIdx = argv.indexOf('--candles');
  return {
    symbols:  symIdx     !== -1 ? argv[symIdx     + 1]?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null,
    top:      topIdx     !== -1 ? parseInt(argv[topIdx     + 1], 10) : 25,
    candles:  candlesIdx !== -1 ? parseInt(argv[candlesIdx + 1], 10) : 100,
    quiet:    argv.includes('--quiet'),
  };
}

// ─── HTTP Helper ─────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// ─── Ticker Fetch (alle Symbole in einem Call) ────────────────────────────────

async function fetchAllTickers() {
  const d = await fetchJson(`${BITUNIX_BASE}/api/v1/futures/market/tickers`);
  if (d.code !== 0) throw new Error(`tickers_api_error: ${d.msg}`);
  return d.data.filter(t => t.symbol.endsWith('USDT')).map(t => ({
    symbol:      t.symbol.replace('USDT', ''),
    price:       parseFloat(t.lastPrice),
    mark_price:  parseFloat(t.markPrice),
    open_24h:    parseFloat(t.open),
    high_24h:    parseFloat(t.high),
    low_24h:     parseFloat(t.low),
    vol_usd_24h: parseFloat(t.quoteVol),
  }));
}

// ─── 5min Kline Fetch für ein Symbol ─────────────────────────────────────────

async function fetchCandles(symbol, limit) {
  const url = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${symbol}USDT&interval=5m&limit=${limit}&type=LAST_PRICE`;
  const d   = await fetchJson(url);
  if (d.code !== 0) throw new Error(`kline_api_error_${d.code}: ${d.msg}`);
  if (!Array.isArray(d.data) || !d.data.length) throw new Error('empty_kline_response');

  // Bitunix liefert neueste zuerst → umkehren zu älteste zuerst
  return d.data.reverse().map(k => ({
    time:  parseInt(k.time),
    open:  parseFloat(k.open),
    high:  parseFloat(k.high),
    low:   parseFloat(k.low),
    close: parseFloat(k.close),
    vol:   parseFloat(k.quoteVol), // vol in USD
  }));
}

// ─── VWAP Berechnung ─────────────────────────────────────────────────────────
// VWAP = Σ(typical_price × vol) / Σ(vol)
// typical_price = (high + low + close) / 3

function computeVwap(candles) {
  let sumPV = 0;
  let sumV  = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    sumPV   += tp * c.vol;
    sumV    += c.vol;
  }
  return sumV > 0 ? +(sumPV / sumV).toFixed(6) : null;
}

// ─── Session H/L aus Kerzen ───────────────────────────────────────────────────

function computeSessionHL(candles) {
  const high = Math.max(...candles.map(c => c.high));
  const low  = Math.min(...candles.map(c => c.low));
  return { session_high: +high.toFixed(6), session_low: +low.toFixed(6) };
}

// ─── Batch-Fetch mit Rate Limiting ───────────────────────────────────────────

async function fetchInBatches(symbols, candleLimit, log) {
  const results = {};
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(sym => fetchCandles(sym, candleLimit).then(candles => ({ sym, candles })))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        const { sym, candles } = r.value;
        const vwap   = computeVwap(candles);
        const { session_high, session_low } = computeSessionHL(candles);
        results[sym] = { candles, vwap, session_high, session_low, candle_count: candles.length };
      } else {
        const sym = batch[settled.indexOf(r)];
        if (!log.quiet) process.stderr.write(
          JSON.stringify({ warn: 'candle_fetch_failed', symbol: sym, detail: r.reason?.message }) + '\n'
        );
      }
    }
    if (i + BATCH_SIZE < symbols.length) {
      await new Promise(res => setTimeout(res, BATCH_DELAY));
    }
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(argv) {
  const args = parseArgs(argv);
  const t0   = Date.now();

  // 1. Alle Ticker laden
  let allTickers;
  try {
    allTickers = await fetchAllTickers();
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'tickers_fetch_failed', detail: e.message }) + '\n');
    process.exit(1);
  }

  // Ticker-Map für schnellen Lookup
  const tickerMap = Object.fromEntries(allTickers.map(t => [t.symbol, t]));

  // 2. Symbol-Liste bestimmen
  let targetSymbols;
  if (args.symbols) {
    // Explizit angegeben — prüfen ob auf Bitunix verfügbar
    targetSymbols = args.symbols.filter(s => {
      if (!tickerMap[s]) {
        if (!args.quiet) process.stderr.write(
          JSON.stringify({ warn: 'symbol_not_on_bitunix', symbol: s }) + '\n'
        );
        return false;
      }
      return true;
    });
  } else {
    // Top-N nach 24h-Volumen (USD)
    targetSymbols = allTickers
      .sort((a, b) => b.vol_usd_24h - a.vol_usd_24h)
      .slice(0, args.top)
      .map(t => t.symbol);
  }

  if (!targetSymbols.length) {
    process.stderr.write(JSON.stringify({ error: 'no_symbols_to_fetch' }) + '\n');
    process.exit(1);
  }

  if (!args.quiet) {
    process.stderr.write(JSON.stringify({
      info:           'intraday_fetch_start',
      symbols:        targetSymbols.length,
      candles_per:    args.candles,
      symbols_sample: targetSymbols.slice(0, 8),
    }) + '\n');
  }

  // 3. 5min-Kerzen fetchen
  const candleData = await fetchInBatches(targetSymbols, args.candles, args);

  // 4. Cache zusammenbauen
  const data = {};
  for (const sym of targetSymbols) {
    const ticker = tickerMap[sym];
    const kData  = candleData[sym];
    if (!kData) continue; // Fetch fehlgeschlagen

    // Letzter Schlusskurs (aktuellste Kerze)
    const lastCandle = kData.candles[kData.candles.length - 1];

    data[sym] = {
      ticker: {
        price:       ticker.price,
        mark_price:  ticker.mark_price,
        open_24h:    ticker.open_24h,
        high_24h:    ticker.high_24h,
        low_24h:     ticker.low_24h,
        vol_usd_24h: ticker.vol_usd_24h,
      },
      candles:      kData.candles,
      vwap:         kData.vwap,
      session_high: kData.session_high,
      session_low:  kData.session_low,
      last_close:   lastCandle.close,
      last_time:    lastCandle.time,
      candle_count: kData.candle_count,
    };
  }

  const fetched   = Object.keys(data).length;
  const failed    = targetSymbols.length - fetched;
  const cache = {
    fetched_at:        new Date().toISOString(),
    duration_ms:       Date.now() - t0,
    symbols_requested: targetSymbols.length,
    symbols_fetched:   fetched,
    symbols_failed:    failed,
    candles_per_symbol: args.candles,
    interval:          '5m',
    data,
  };

  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8');

  const summary = {
    info:              'intraday_fetch_done',
    fetched_at:        cache.fetched_at,
    symbols_requested: targetSymbols.length,
    symbols_fetched:   fetched,
    symbols_failed:    failed,
    candles_per:       args.candles,
    duration_ms:       cache.duration_ms,
    cache_path:        CACHE_PATH,
  };

  if (!args.quiet) {
    process.stderr.write(JSON.stringify(summary) + '\n');
  }
  // Stdout: kompaktes Summary-JSON (wird von intraday_monitor gelesen)
  process.stdout.write(JSON.stringify(summary) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv).catch(e => {
    process.stderr.write(JSON.stringify({ error: 'intraday_fetcher_crash', detail: e.message }) + '\n');
    process.exit(1);
  });
}

export { fetchAllTickers, fetchCandles, computeVwap, computeSessionHL };
